# [ADR-005] 面向个人本地使用全面裁剪仓库非核心目录与构建配置

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：上游仓库包含容器编排、K8s、监控栈、多租户扩展、48 个第三方集成、大型系统评测集、多语言客户端、PyPI 元包及完整的 Docusaurus 官网与配图，对个人本地开发与打包发布冗余度过高。
- **方案**（保留 `hindsight-api-slim`、`hindsight-embed`、`hindsight-control-plane`、`hindsight-integrations/coding-agents`、`hindsight-clients/typescript`、`hindsight-dev` 及核心文档）：
  - **容器与部署/监控**：移除 `docker/`、`.dockerignore`、`Dockerfile*`、`helm/`、`scripts/dev/monitoring/`、`scripts/dev/start-monitoring.sh`、`monitoring/`。
  - **CI/CD、发版与跑分脚本**：移除 `.github/`、`.cursor-plugin/`、`scripts/benchmarks/` 及发版/集成校验/文档生成等非本地脚本（`release*.sh`、`check-integration-*.sh`、`generate-docs-skill.sh`、`sync-cookbook.sh`、`test-doc-examples.sh`、`update-docs-version.sh`、`smoke-test-slim.sh`、`run-upgrade-tests.sh`、`test-hermes-compat.sh`、`triage-labels.py`、`start-docs.sh`、`start-oracle.sh` 等）；移除 `hindsight-dev/` 中 `generate_changelog.py`、`generate_llms_full.py`、`sync_cookbook.py` 及对应脚本入口与单测。
  - **集成、评测、多端包装与元包**：移除 `hindsight-integrations/` 下除 `coding-agents/` 外的 47 个集成目录；移除 `hindsight-extensions/`、`cookbook/`、`skills/`、`hindsight-system-tests/`、`hindsight-system-evals/`、`hindsight-integration-tests/`、`hindsight-all/`、`hindsight-all-npm/`、`hindsight-cli/`、`hindsight-clients/{go,rust,python}/`；移除空壳 PyPI 元包 `hindsight-api/`、`hindsight-all-slim/`（同步修改根 `package.json`、`pyproject.toml`、`hindsight-dev/pyproject.toml` 与 `uv.lock`）。
  - **文档站点精简**：清理 `hindsight-docs/` 下全部 413 个多媒体文件（约 161.2 MB），以及 `guides/`、`blog/`、`versioned_docs/`、`versioned_sidebars/`、`versions.json`、`examples/`、`figures/`、`docs-integrations/`、`scripts/`、`plugins/`、`src/`、`static/` 与 Docusaurus 构建配置文件，仅留纯 Markdown 文档 `docs/`、`docs-private/` 与 `README.md`。
- **影响范围**：仓库顶层结构、`package.json`、`pyproject.toml`、`hindsight-dev/`、`hindsight-docs/`、`hindsight-integrations/`、`scripts/`、`uv.lock`。
- **与上游差异**：上述目录与包装包均可在需要时从上游 `main` 恢复；后续参考上游时忽略对应已移除路径的变更。
