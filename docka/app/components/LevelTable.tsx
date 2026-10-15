import { TRUST_LADDER } from "@/lib/verification-level";

// The ONE public trust-ladder table (SEO plan S5): extracted from the former inline
// `LevelTable` in app/about/page.tsx and now rendered from `TRUST_LADDER`, the
// plainPunct'd projection of LEVEL_META (lib/verification-level.ts). Server component, no
// client hooks. Its canonical home is the how-verification-works guide; /about, the
// registry pages and the other guides carry one line and a link instead of a copy.
export function LevelTable({ className }: { className?: string }) {
  return (
    <div className={className ?? "mt-4 overflow-x-auto"} data-testid="level-table">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left align-bottom text-slate-900">
            <th className="py-2 pr-4 font-semibold">Level</th>
            <th className="py-2 pr-4 font-semibold">Name</th>
            <th className="py-2 font-semibold">What it means</th>
          </tr>
        </thead>
        <tbody className="align-top">
          {TRUST_LADDER.map((row) => (
            <tr key={row.code} className="border-b border-slate-100" data-level={row.code}>
              <td className="py-2 pr-4 font-bold text-slate-900">{row.code}</td>
              <td className="py-2 pr-4 font-medium text-slate-800">{row.name}</td>
              <td className="py-2 text-slate-700">{row.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default LevelTable;
