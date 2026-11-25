"use client";

import React, { createContext, useCallback, useContext, useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { client } from "./api";
import { shouldDeferDataplaneFetch } from "./base-path";

interface Features {
  observations: boolean;
  mcp: boolean;
  worker: boolean;
  bank_config_api: boolean;
  bank_llm_health: boolean;
  access_key_auth: boolean;
  document_export_api: boolean;
  document_import_api: boolean;
  knowledge_banks: boolean;
  audit_log: boolean;
  llm_trace: boolean;
  store_document_text: boolean;
}

interface FeaturesContextType {
  features: Features | null;
  loading: boolean;
  error: string | null;
  refreshFeatures: () => Promise<void>;
}

const defaultFeatures: Features = {
  observations: false,
  mcp: false,
  worker: false,
  bank_config_api: false,
  bank_llm_health: false,
  access_key_auth: false,
  document_export_api: false,
  document_import_api: false,
  knowledge_banks: false,
  audit_log: false,
  llm_trace: false,
  // Default to true so the "text not stored" warning only appears when the
  // server explicitly reports text storage is disabled (and not on fetch errors).
  store_document_text: true,
};

const FeaturesContext = createContext<FeaturesContextType | undefined>(undefined);

export function FeaturesProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const skipFetch = shouldDeferDataplaneFetch(pathname);
  const [features, setFeatures] = useState<Features | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const loadFeatures = useCallback(async () => {
    setLoading(true);
    try {
      const response = await client.getVersion();
      loadedRef.current = true;
      setFeatures({ ...defaultFeatures, ...response.features });
      setError(null);
    } catch (err) {
      console.error("Error loading features:", err);
      setError("Failed to load feature flags");
      // Use defaults on error
      setFeatures(defaultFeatures);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skipFetch) {
      if (!loadedRef.current) {
        setFeatures((prev) => prev ?? defaultFeatures);
        setLoading(false);
      }
      return;
    }
    if (loadedRef.current) return;
    void loadFeatures();
  }, [skipFetch, loadFeatures]);

  return (
    <FeaturesContext.Provider value={{ features, loading, error, refreshFeatures: loadFeatures }}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures() {
  const context = useContext(FeaturesContext);
  if (context === undefined) {
    throw new Error("useFeatures must be used within a FeaturesProvider");
  }
  return context;
}
