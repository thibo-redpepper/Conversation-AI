import React, { useState } from "react";

type TxtRecord = { name: string; value: string };
type MxRecord = { name: string; value: string; priority: string };
type CnameRecord = { name: string; value: string };

const DnsSetup: React.FC = () => {
  const [provider] = useState("Mailgun");
  const [domain, setDomain] = useState("");
  const [txtSpf, setTxtSpf] = useState<TxtRecord>({ name: "", value: "" });
  const [txtDkim, setTxtDkim] = useState<TxtRecord>({ name: "", value: "" });
  const [txtDmarc, setTxtDmarc] = useState<TxtRecord>({ name: "", value: "" });
  const [mxRecords, setMxRecords] = useState<MxRecord[]>([
    { name: "", value: "", priority: "" },
    { name: "", value: "", priority: "" },
  ]);
  const [cname, setCname] = useState<CnameRecord>({ name: "", value: "" });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const txtRecords = [txtSpf, txtDkim, txtDmarc].filter(
        (record) => record.name.trim() && record.value.trim()
      );
      const response = await fetch("/api/dns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          domain,
          txtRecords,
          mxRecords,
          cname,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Opslaan mislukt.");
      }
      setStatus("DNS instellingen opgeslagen in Supabase.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Opslaan mislukt.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>DNS Setup</h1>
          <p>Plak hier je DNS‑records. Dit wordt niet automatisch ingesteld.</p>
        </div>
        <a className="toggle" href="/crm/pipedrive">
          Terug naar CRM
        </a>
      </header>

      <section className="panel">
        <header className="panel__header">
          <h2>Domein</h2>
        </header>
        <div className="panel__body">
          <div className="field">
            <label>Domein</label>
            <input
              className="input"
              placeholder="voorbeeld.be"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
          </div>
          <div className="alert alert--note">
            Provider: <strong>{provider}</strong>. Kopieer exact de DNS‑records uit
            Mailgun en plak ze hier.
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>TXT records (Mailgun)</h2>
        </header>
        <div className="panel__body">
          <div className="field">
            <label>SPF (TXT)</label>
            <div className="field-row">
              <input
                className="input"
                placeholder="Host (bv. test)"
                value={txtSpf.name}
                onChange={(event) =>
                  setTxtSpf({ ...txtSpf, name: event.target.value })
                }
              />
              <input
                className="input"
                placeholder="Value (v=spf1 ...)"
                value={txtSpf.value}
                onChange={(event) =>
                  setTxtSpf({ ...txtSpf, value: event.target.value })
                }
              />
            </div>
          </div>
          <div className="field">
            <label>DKIM (TXT)</label>
            <div className="field-row">
              <input
                className="input"
                placeholder="Host (bv. krs._domainkey.test)"
                value={txtDkim.name}
                onChange={(event) =>
                  setTxtDkim({ ...txtDkim, name: event.target.value })
                }
              />
              <input
                className="input"
                placeholder="Value (k=rsa; p=...)"
                value={txtDkim.value}
                onChange={(event) =>
                  setTxtDkim({ ...txtDkim, value: event.target.value })
                }
              />
            </div>
          </div>
          <div className="field">
            <label>DMARC (TXT, optioneel)</label>
            <div className="field-row">
              <input
                className="input"
                placeholder="Host (bv. _dmarc.test)"
                value={txtDmarc.name}
                onChange={(event) =>
                  setTxtDmarc({ ...txtDmarc, name: event.target.value })
                }
              />
              <input
                className="input"
                placeholder="Value (v=DMARC1; p=none; ...)"
                value={txtDmarc.value}
                onChange={(event) =>
                  setTxtDmarc({ ...txtDmarc, value: event.target.value })
                }
              />
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>MX records (2)</h2>
        </header>
        <div className="panel__body">
          {mxRecords.map((record, index) => (
            <div className="field-row" key={`mx-${index}`}>
              <input
                className="input"
                placeholder="Naam/Host"
                value={record.name}
                onChange={(event) => {
                  const next = [...mxRecords];
                  next[index] = { ...record, name: event.target.value };
                  setMxRecords(next);
                }}
              />
              <input
                className="input"
                placeholder="Value"
                value={record.value}
                onChange={(event) => {
                  const next = [...mxRecords];
                  next[index] = { ...record, value: event.target.value };
                  setMxRecords(next);
                }}
              />
              <input
                className="input"
                placeholder="Priority"
                value={record.priority}
                onChange={(event) => {
                  const next = [...mxRecords];
                  next[index] = { ...record, priority: event.target.value };
                  setMxRecords(next);
                }}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>CNAME record (1)</h2>
        </header>
        <div className="panel__body">
          <div className="field-row">
            <input
              className="input"
              placeholder="Naam/Host"
              value={cname.name}
              onChange={(event) => setCname({ ...cname, name: event.target.value })}
            />
            <input
              className="input"
              placeholder="Value"
              value={cname.value}
              onChange={(event) => setCname({ ...cname, value: event.target.value })}
            />
          </div>
        </div>
      </section>

      <section className="panel">
        <header className="panel__header">
          <h2>Samenvatting (kopieer)</h2>
        </header>
        <div className="panel__body">
          {status ? <div className="alert alert--success">{status}</div> : null}
          <button className="button" onClick={handleSave} disabled={saving}>
            {saving ? "Opslaan..." : "Opslaan in Supabase"}
          </button>
          <pre className="code-block">
{`Provider: ${provider}
Domein: ${domain || "—"}

TXT:
  SPF  ${txtSpf.name || "—"} → ${txtSpf.value || "—"}
  DKIM ${txtDkim.name || "—"} → ${txtDkim.value || "—"}
  DMARC ${txtDmarc.name || "—"} → ${txtDmarc.value || "—"}

MX:
${mxRecords
  .map(
    (record, idx) =>
      `  ${idx + 1}. ${record.name || "—"} → ${record.value || "—"} (prio ${
        record.priority || "—"
      })`
  )
  .join("\n")}

CNAME:
  ${cname.name || "—"} → ${cname.value || "—"}
`}
          </pre>
        </div>
      </section>
    </div>
  );
};

export default DnsSetup;
