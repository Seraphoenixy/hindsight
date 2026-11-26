"""HTTP routes for Working Rules: ``/v1/default/working-rules``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..engine.working_rules import (
    WorkingRuleAction,
    WorkingRuleError,
    WorkingRuleImportance,
    WorkingRuleMutationResult,
    WorkingRuleOrganizeApplyResult,
    WorkingRuleOrganizePreview,
    WorkingRuleOrganizeProposalItem,
    WorkingRulePromotedResult,
    WorkingRuleRecord,
    WorkingRulesListResult,
    WorkingRulesProjection,
)
from ..extensions.tenant import AuthenticationError
from ..models import RequestContext
from ..pagination import TRIM_TO_PAGE
from .unknown_params import use_unknown_params_routes

PREFIX = "/v1/default/working-rules"


class CreateWorkingRuleRequest(BaseModel):
    """Request body for creating a Working Rule."""

    content: str = Field(description="Rule content (whitespace-folded; UTF-8 byte ceiling applies)")
    importance: WorkingRuleImportance = Field(default="normal", description="'critical', 'normal', or 'low'")


class MutateWorkingRuleRequest(BaseModel):
    """Request body for semantic add/replace/remove mutation (used by coding-agent tools)."""

    action: WorkingRuleAction = Field(description="'add', 'replace', or 'remove'")
    content: str | None = Field(default=None, description="Rule content (required for add/replace)")
    old_text: str | None = Field(
        default=None,
        description="Full existing content or unique substring (required for replace/remove)",
    )
    importance: WorkingRuleImportance | None = Field(
        default=None,
        description="Importance level; replace keeps existing higher importance by default",
    )
    preserve_importance: bool = Field(
        default=True,
        description="When true, replace preserves existing higher importance unless raised",
    )


class UpdateWorkingRuleRequest(BaseModel):
    """Request body for updating a Working Rule by ID."""

    content: str | None = None
    importance: WorkingRuleImportance | None = None
    is_archived: bool | None = None


class DeleteWorkingRuleResponse(BaseModel):
    """Response returned when a Working Rule is permanently deleted."""

    status: str = "deleted"


class PromoteWorkingRuleRequest(BaseModel):
    """Request body for retaining an archived Working Rule into a memory bank."""

    bank_id: str = Field(description="Target memory bank ID")
    tags: list[str] = Field(default_factory=list, description="Optional tags to attach to the retained document")


class ExportWorkingRulesResponse(BaseModel):
    """Markdown export of Working Rules."""

    markdown: str


class WorkingRuleOrganizePreviewRequest(BaseModel):
    """Request body for generating an AI organization preview for Working Rules."""

    instructions: str = Field(default="", description="Optional reviewer instructions")


class WorkingRuleOrganizeApplyRequest(BaseModel):
    """Request body for applying selected Working Rules organization proposals."""

    expected_revision: str = Field(description="Revision returned by the preview endpoint")
    proposals: list[WorkingRuleOrganizeProposalItem] = Field(default_factory=list)


def _to_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, AuthenticationError):
        return HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, WorkingRuleError):
        return HTTPException(status_code=exc.status_code, detail=str(exc))
    return HTTPException(status_code=500, detail=str(exc))


def build_router(get_request_context: Callable[..., RequestContext]) -> APIRouter:
    """Build the FastAPI router for ``/v1/default/working-rules``."""
    router = APIRouter(prefix=PREFIX, tags=["Working Rules"])

    @router.get(
        "",
        response_model=WorkingRulesListResult,
        summary="List working rules",
        operation_id="list_working_rules",
    )
    async def list_working_rules(
        request: Request,
        include_archived: bool = Query(default=False),
        q: str | None = Query(default=None, description="Case-insensitive substring search"),
        limit: Annotated[int, Query(ge=0), TRIM_TO_PAGE] = 100,
        offset: int = Query(default=0, ge=0),
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRulesListResult:
        try:
            return await request.app.state.memory.working_rules.list_working_rules(
                include_archived=include_archived,
                q=q,
                limit=limit,
                offset=offset,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.get(
        "/projection",
        response_model=WorkingRulesProjection,
        summary="Get working rules projection",
        operation_id="get_working_rules_projection",
    )
    async def get_working_rules_projection(
        request: Request,
        max_chars: int | None = Query(default=None, ge=0),
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRulesProjection:
        try:
            return await request.app.state.memory.working_rules.get_working_rules_projection(
                max_chars=max_chars,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.get(
        "/export",
        response_model=ExportWorkingRulesResponse,
        summary="Export working rules as Markdown",
        operation_id="export_working_rules",
    )
    async def export_working_rules(
        request: Request,
        include_archived: bool = Query(default=False),
        rc: RequestContext = Depends(get_request_context),
    ) -> ExportWorkingRulesResponse:
        try:
            markdown = await request.app.state.memory.working_rules.export_working_rules_markdown(
                include_archived=include_archived,
                request_context=rc,
            )
            return ExportWorkingRulesResponse(markdown=markdown)
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "/mutate",
        response_model=WorkingRuleMutationResult,
        summary="Mutate working rules by action and text match",
        operation_id="mutate_working_rules",
    )
    async def mutate_working_rules(
        body: MutateWorkingRuleRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleMutationResult:
        try:
            return await request.app.state.memory.working_rules.mutate_working_rule(
                action=body.action,
                content=body.content,
                old_text=body.old_text,
                importance=body.importance,
                preserve_importance=body.preserve_importance,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "/organize/preview",
        response_model=WorkingRuleOrganizePreview,
        summary="Preview AI-proposed working rules organization",
        operation_id="preview_working_rules_organization",
    )
    async def preview_working_rules_organization(
        body: WorkingRuleOrganizePreviewRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleOrganizePreview:
        try:
            return await request.app.state.memory.working_rules.preview_working_rules_organization(
                instructions=body.instructions,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "/organize/apply",
        response_model=WorkingRuleOrganizeApplyResult,
        summary="Apply approved working rules organization proposals",
        operation_id="apply_working_rules_organization",
    )
    async def apply_working_rules_organization(
        body: WorkingRuleOrganizeApplyRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleOrganizeApplyResult:
        try:
            return await request.app.state.memory.working_rules.apply_working_rules_organization(
                expected_revision=body.expected_revision,
                proposals=body.proposals,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "",
        response_model=WorkingRuleMutationResult,
        summary="Create a working rule",
        operation_id="create_working_rule",
    )
    async def create_working_rule(
        body: CreateWorkingRuleRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleMutationResult:
        try:
            return await request.app.state.memory.working_rules.create_working_rule(
                content=body.content,
                importance=body.importance,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.get(
        "/{rule_id}",
        response_model=WorkingRuleRecord,
        summary="Get a working rule by ID",
        operation_id="get_working_rule",
    )
    async def get_working_rule(
        rule_id: str,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleRecord:
        try:
            rule = await request.app.state.memory.working_rules.get_working_rule(rule_id, request_context=rc)
            if rule is None:
                raise HTTPException(status_code=404, detail=f"Working rule '{rule_id}' not found")
            return rule
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.patch(
        "/{rule_id}",
        response_model=WorkingRuleRecord,
        summary="Update a working rule by ID",
        operation_id="update_working_rule",
    )
    async def update_working_rule(
        rule_id: str,
        body: UpdateWorkingRuleRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleRecord:
        try:
            return await request.app.state.memory.working_rules.update_working_rule_by_id(
                rule_id,
                content=body.content,
                importance=body.importance,
                is_archived=body.is_archived,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "/{rule_id}/restore",
        response_model=WorkingRuleRecord,
        summary="Restore an archived working rule",
        operation_id="restore_working_rule",
    )
    async def restore_working_rule(
        rule_id: str,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRuleRecord:
        try:
            return await request.app.state.memory.working_rules.update_working_rule_by_id(
                rule_id,
                is_archived=False,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.post(
        "/{rule_id}/promote",
        response_model=WorkingRulePromotedResult,
        summary="Promote an archived working rule into a memory bank",
        operation_id="promote_working_rule",
    )
    async def promote_working_rule(
        rule_id: str,
        body: PromoteWorkingRuleRequest,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> WorkingRulePromotedResult:
        try:
            return await request.app.state.memory.working_rules.promote_archived_rule_to_memory(
                rule_id,
                bank_id=body.bank_id,
                tags=body.tags,
                request_context=rc,
            )
        except Exception as exc:
            raise _to_http_error(exc) from exc

    @router.delete(
        "/{rule_id}",
        response_model=DeleteWorkingRuleResponse,
        summary="Delete a working rule permanently",
        operation_id="delete_working_rule",
    )
    async def delete_working_rule(
        rule_id: str,
        request: Request,
        rc: RequestContext = Depends(get_request_context),
    ) -> DeleteWorkingRuleResponse:
        try:
            deleted = await request.app.state.memory.working_rules.delete_working_rule(rule_id, request_context=rc)
            if not deleted:
                raise HTTPException(status_code=404, detail=f"Working rule '{rule_id}' not found")
            return DeleteWorkingRuleResponse()
        except Exception as exc:
            raise _to_http_error(exc) from exc

    use_unknown_params_routes(router)
    return router
