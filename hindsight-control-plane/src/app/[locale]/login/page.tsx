"use client";

import { Suspense, useState, FormEvent, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/language-switcher";
import { sanitizeReturnTo, withBasePath } from "@/lib/base-path";
import { useTheme } from "@/lib/theme-context";
import { Moon, Sun } from "lucide-react";
import Image from "next/image";

function LoginForm() {
  const t = useTranslations("login");
  const tNav = useTranslations("nav");
  const { theme, toggleTheme } = useTheme();
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Validate returnTo to prevent open-redirect via crafted login links.
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));

  useEffect(() => {
    // Focus the input on mount
    const input = document.getElementById("access-key");
    input?.focus();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(withBasePath("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });

      if (res.ok) {
        // Navigate to the returnTo URL
        router.push(returnTo);
        router.refresh();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || t("invalidKey"));
      }
    } catch {
      setError(t("connectFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-dvh bg-background bg-[radial-gradient(circle_at_50%_30%,rgba(0,116,217,0.10),transparent_48%)] dark:bg-[radial-gradient(circle_at_50%_30%,rgba(91,176,255,0.09),transparent_48%)] flex items-center justify-center p-4">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground"
          onClick={toggleTheme}
          aria-label={theme === "light" ? tNav("darkMode") : tNav("lightMode")}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </Button>
        <LanguageSwitcher />
      </div>
      <Card className="relative w-full max-w-md overflow-hidden rounded-[20px] border-border shadow-[0_24px_80px_-48px_rgba(0,55,120,0.45)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent"
        />
        <CardHeader className="space-y-3 pt-8 text-center">
          <Image
            src={withBasePath("/logo.png")}
            alt="Hindsight"
            width={180}
            height={47}
            className="mx-auto h-auto w-44"
            unoptimized
          />
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                id="access-key"
                type="password"
                placeholder={t("accessKeyPlaceholder")}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
              />
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <Button type="submit" variant="gradient" className="w-full" disabled={loading || !key}>
              {loading ? t("signingIn") : t("signIn")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
