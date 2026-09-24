import { LoaderCircle } from "lucide-react";

/** Keep the entry neutral until its manifest and optional login UI are resolved. */
export default function EntryLoadingPage() {
  return (
    <div className="workspace-entry-shell" role="status" aria-label="Loading" aria-busy="true">
      <LoaderCircle className="workspace-entry-spinner" size={38} aria-hidden="true" />
    </div>
  );
}
