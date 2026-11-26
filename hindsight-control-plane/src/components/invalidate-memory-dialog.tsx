"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface InvalidateMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason?: string) => void;
  busy?: boolean;
}

// Confirmation dialog for invalidating (soft-retiring) a memory: explains what
// invalidation does and collects an optional reason.
export function InvalidateMemoryDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
}: InvalidateMemoryDialogProps) {
  const t = useTranslations("memoryDetailPanel");
  const [reason, setReason] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setReason("");
    onOpenChange(nextOpen);
  };

  const handleConfirm = () => {
    const trimmed = reason.trim() || undefined;
    setReason("");
    onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("curationInvalidateTitle")}</DialogTitle>
          <DialogDescription>{t("curationInvalidateExplain")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("curationReasonPlaceholder")}
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("curationReasonPlaceholder")}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => handleOpenChange(false)}>
            {t("curationCancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={handleConfirm}>
            {t("curationInvalidate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
