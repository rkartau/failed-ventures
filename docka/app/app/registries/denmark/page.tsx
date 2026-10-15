import type { Metadata } from "next";
import { registryPage } from "@/lib/registry-pages";
import { RegistryCountryPage, registryPageMetadata } from "@/components/RegistryCountryPage";

// PUBLIC, INDEXABLE per-registry page (SEO plan WP-E, E2): a thin wrapper. All prose lives
// in lib/registry-pages.ts; the shell is components/RegistryCountryPage.tsx.
const PAGE = registryPage("denmark")!;

export const metadata: Metadata = registryPageMetadata(PAGE);

export default function DenmarkRegistryPage() {
  return <RegistryCountryPage page={PAGE} />;
}
