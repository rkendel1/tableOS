import { useState } from "react";
import { useQuery } from "@feltdb/feltkit/react";
import { ActivityTimeline, PageHeader } from "@stack-ui/react";
import { Select } from "../fields";
import { api } from "../../feltkit/_generated/api";
import { SUBJECT_TYPES } from "../../feltkit/_constants";

export function Activity() {
  const [subjectType, setSubjectType] = useState("");
  const [limit, setLimit] = useState(100);
  const events = useQuery(api.insights.audit, { ...(subjectType ? { subjectType: subjectType as never } : {}), limit });
  return (
    <>
      <PageHeader title="Audit trail" description="Every change to the restaurant's records, written in the same transaction as the change. The request id links each entry to FeltKit's activity log (authorization decision and committed writes) in Studio." />
      <Select label="Records" value={subjectType} onChange={setSubjectType} options={[{ value: "", label: "All" }, ...SUBJECT_TYPES.map((s) => ({ value: s, label: s }))]} />
      <ActivityTimeline
        loading={!events}
        hasMore={!!events && events.length === limit}
        onMore={() => setLimit(Math.min(500, limit + 100))}
        items={(events ?? []).map((e) => ({
          id: e.id,
          at: e.at,
          actor: `${e.actor} (${e.actorType})`,
          summary: `${e.type} · ${e.subjectType}`,
          detail: <><code className="small">request {e.requestId}</code>{e.data && <pre className="json">{JSON.stringify(e.data, null, 1)}</pre>}</>,
        }))}
      />
    </>
  );
}
