// src/pages/QuestionBank.jsx
//
// Standalone "Question Bank" tab: multiple-choice practice questions (RTO
// Learner/Driving test style) with search, add/edit/delete and bulk import
// from a CSV/Excel sheet. See supabase/migrations/026_question_bank.sql.
//
// Only Admin can add/edit/delete/import (enforced by RLS too, not just this
// UI) -- everyone else gets a read-only, searchable list, since this is
// shared reference material rather than per-staff data.
//
// SAFE MODE (Admin): Edit / Delete buttons are hidden by default so a stray
// click can't delete a question. Click a row to reveal that row's Edit and
// Delete buttons; click the row again (or another row, search, change page)
// to hide them.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Card, GhostButton, PrimaryButton, Toast, Modal, Field, Select, Input } from "../components/UI";
import { fetchAllRows } from "../lib/fetchAll";
import * as XLSX from "xlsx";
import { Search, Upload, Plus, Pencil, Trash2 } from "lucide-react";

const PAGE_SIZE = 50;

// A question/option cell can hold a bare image URL or markdown
// ![alt](url) instead of (or alongside) plain text. Pull any image URLs out
// and return what's left as the plain-text part -- search only ever matches
// that text part, never the URL, same as the user asked for.
const IMG_MD_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
const IMG_URL_RE = /https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?/gi;
function parseCell(raw) {
  const text = String(raw ?? "");
  const images = [];
  let rest = text.replace(IMG_MD_RE, (_, url) => { images.push(url); return " "; });
  rest = rest.replace(IMG_URL_RE, (m) => { images.push(m); return " "; });
  return { text: rest.replace(/\s+/g, " ").trim(), images };
}
function searchText(raw) {
  return parseCell(raw).text.toLowerCase();
}

function Cell({ value }) {
  const { text, images } = parseCell(value);
  if (!text && !images.length) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  return (
    <div>
      {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
      {images.map((src, i) => (
        <a key={i} href={src} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-block mt-1 mr-1" title="Open full-size">
          <img src={src} alt="" className="h-12 w-auto rounded border border-slate-200 dark:border-slate-700 object-contain bg-white" />
        </a>
      ))}
    </div>
  );
}

const EMPTY_FORM = { question: "", option1: "", option2: "", option3: "", option4: "", answer: "1", chapter: "" };

export default function QuestionBank({ isAdmin = false, staff } = {}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState(null);
  const [activeId, setActiveId] = useState(null); // safe mode: row whose Edit/Delete buttons are showing

  const [editing, setEditing] = useState(null); // null = closed, {} = new row, row = editing that row
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);

  // Writes are Admin-only (RLS enforces this too) -- shown as read-only
  // reference material to every other role.
  const canWrite = isAdmin;

  const load = async () => {
    setLoading(true);
    setError("");
    const res = await fetchAllRows(() =>
      supabase.from("question_bank").select("*")
        .order("sr_no", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
    );
    if (res.error) setError("Couldn't load the question bank: " + res.error.message);
    else setRows(res.data || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.question, r.option1, r.option2, r.option3, r.option4].some((c) => searchText(c).includes(q))
    );
  }, [rows, search]);

  useEffect(() => { setPage(1); setActiveId(null); }, [search]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  useEffect(() => { setActiveId(null); }, [safePage]);

  const openAdd = () => { setForm(EMPTY_FORM); setEditing({}); };
  const openEdit = (r) => {
    setForm({
      question: r.question || "", option1: r.option1 || "", option2: r.option2 || "",
      option3: r.option3 || "", option4: r.option4 || "", answer: String(r.answer || 1), chapter: r.chapter || "",
    });
    setEditing(r);
  };
  const closeModal = () => setEditing(null);
  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    const q = form.question.trim();
    const o1 = form.option1.trim(), o2 = form.option2.trim(), o3 = form.option3.trim(), o4 = form.option4.trim();
    if (!q || !o1 || !o2 || !o3) { setToast("Question aur kam se kam 3 option bharna zaroori hai"); return; }
    setSaving(true);
    const payload = {
      question: q, option1: o1, option2: o2, option3: o3, option4: o4,
      answer: Number(form.answer), chapter: form.chapter.trim() || null,
    };
    let err;
    if (editing && editing.id) {
      ({ error: err } = await supabase.from("question_bank").update(payload).eq("id", editing.id));
    } else {
      if (staff?.id) payload.created_by = staff.id;
      ({ error: err } = await supabase.from("question_bank").insert(payload));
    }
    setSaving(false);
    if (err) { setToast("Save failed: " + err.message); return; }
    setEditing(null);
    setActiveId(null);
    setToast(editing?.id ? "Question updated" : "Question added");
    load();
  };

  const remove = async (r) => {
    if (!window.confirm("Ye question hatana hai?")) return;
    const { error: err } = await supabase.from("question_bank").delete().eq("id", r.id);
    if (err) { setToast("Delete failed: " + err.message); return; }
    setRows((rs) => rs.filter((x) => x.id !== r.id));
    setActiveId(null);
    setToast("Question deleted");
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Question Bank</h2>
        {canWrite && (
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => setImportOpen(true)} className="inline-flex items-center gap-1.5">
              <Upload size={14} /> Upload CSV/Excel
            </GhostButton>
            <PrimaryButton onClick={openAdd} className="inline-flex items-center gap-1.5">
              <Plus size={14} /> Add Question
            </PrimaryButton>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search question or options…"
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <span className="text-xs text-slate-400 dark:text-slate-500">{filtered.length} question{filtered.length !== 1 ? "s" : ""}</span>
        {canWrite && (
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Safe mode: Edit/Delete dekhne ke liye question ki row par click karein
          </span>
        )}
      </div>

      <Card className="!p-0 overflow-hidden">
        {error && <p className="text-rose-500 text-sm p-4">{error}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-14" />
              <col className="w-[22%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-16" />
              {canWrite && <col className="w-20" />}
            </colgroup>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400">
                <th className="text-left font-medium px-3 py-2">S.No</th>
                <th className="text-left font-medium px-3 py-2">Question</th>
                <th className="text-left font-medium px-3 py-2">Option 1</th>
                <th className="text-left font-medium px-3 py-2">Option 2</th>
                <th className="text-left font-medium px-3 py-2">Option 3</th>
                <th className="text-left font-medium px-3 py-2">Option 4</th>
                <th className="text-left font-medium px-3 py-2">Answer</th>
                {canWrite && <th className="text-left font-medium px-3 py-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={canWrite ? 8 : 7} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">Loading…</td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={canWrite ? 8 : 7} className="px-3 py-8 text-center text-slate-400 dark:text-slate-500">No questions found.</td></tr>
              ) : (
                pageRows.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={canWrite ? () => setActiveId((id) => (id === r.id ? null : r.id)) : undefined}
                    className={`border-t border-slate-100 dark:border-slate-800 align-top hover:bg-slate-50/60 dark:hover:bg-slate-800/30 ${canWrite ? "cursor-pointer" : ""} ${activeId === r.id ? "bg-blue-50/60 dark:bg-blue-950/20" : ""}`}
                  >
                    <td className="px-3 py-2 text-slate-400 dark:text-slate-500">{(safePage - 1) * PAGE_SIZE + i + 1}</td>
                    <td className="px-3 py-2 text-slate-800 dark:text-slate-100 font-medium"><Cell value={r.question} /></td>
                    {[1, 2, 3, 4].map((n) => (
                      <td key={n} className={`px-3 py-2 align-top text-slate-700 dark:text-slate-200 ${r.answer === n ? "bg-emerald-50/70 dark:bg-emerald-950/20" : ""}`}>
                        <Cell value={r[`option${n}`]} />
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold text-xs">{r.answer}</span>
                    </td>
                    {canWrite && (
                      <td className="px-3 py-2 whitespace-nowrap">
                        {activeId === r.id ? (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); openEdit(r); }} className="text-blue-600 dark:text-blue-400 hover:underline mr-3 inline-flex items-center" title="Edit"><Pencil size={14} /></button>
                            <button onClick={(e) => { e.stopPropagation(); remove(r); }} className="text-rose-500 hover:underline inline-flex items-center" title="Delete"><Trash2 size={14} /></button>
                          </>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600 select-none" title="Click the row to show Edit / Delete">•••</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
          <span>
            {filtered.length === 0 ? "0 questions" : `Showing ${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length}`}
          </span>
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} className="!px-2.5 !py-1 !text-xs">Prev</GhostButton>
            <span>Page {safePage} of {totalPages}</span>
            <GhostButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} className="!px-2.5 !py-1 !text-xs">Next</GhostButton>
          </div>
        </div>
      </Card>

      {editing && (
        <Modal title={editing.id ? "Edit Question" : "Add Question"} onClose={closeModal} size="md">
          <Field label="Question" required>
            <Input as="textarea" value={form.question} onChange={setField("question")} placeholder="Question likhein, ya image ka seedha URL (.jpg/.png)" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
            <Field label="Option 1" required><Input value={form.option1} onChange={setField("option1")} /></Field>
            <Field label="Option 2" required><Input value={form.option2} onChange={setField("option2")} /></Field>
            <Field label="Option 3" required><Input value={form.option3} onChange={setField("option3")} /></Field>
            <Field label="Option 4" required><Input value={form.option4} onChange={setField("option4")} /></Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
            <Field label="Correct Answer" required>
              <Select value={form.answer} onChange={setField("answer")}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>Option {n}</option>)}
              </Select>
            </Field>
            <Field label="Chapter (optional)"><Input value={form.chapter} onChange={setField("chapter")} /></Field>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 mb-2">
            Kisi bhi field me image ka seedha URL (http…, .jpg/.png/.gif) daalne par wo yahan aur list me image ki tarah dikhega.
          </p>
          <div className="flex items-center justify-end gap-2 mt-2">
            <GhostButton onClick={closeModal}>Cancel</GhostButton>
            <PrimaryButton onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</PrimaryButton>
          </div>
        </Modal>
      )}

      {importOpen && (
        <ImportModal onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); load(); }} staff={staff} />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Reads the header row then maps every row into our fields, trying a few
// header spellings so "Option 1" / "Option1" / "OPTION-1" / "Q.NO" etc. all
// match (same loose-match approach as the Applications CSV importer).
function mapRow(headers, raw) {
  const row = {};
  headers.forEach((h, i) => {
    const key = normalizeHeader(h);
    const v = raw[i];
    if (v === undefined || v === null || String(v).trim() === "") return;
    const val = String(v).trim();
    if (key === "question") row.question = val;
    else if (key === "option1") row.option1 = val;
    else if (key === "option2") row.option2 = val;
    else if (key === "option3") row.option3 = val;
    else if (key === "option4") row.option4 = val;
    else if (key === "answer") row.answerRaw = val;
    else if (key === "chapter") row.chapter = val;
    else if (key === "qno" || key === "qnumber" || key === "questionno") row.qno = val;
    else if (key === "sno" || key === "srno" || key === "slno") row.sno = val;
  });
  return row;
}

// Answer column is usually 1-4 (as in the sample sheet); fall back to
// matching the correct option's own text in case a sheet spells it out
// instead (e.g. "Stop" rather than "1").
function resolveAnswer(row) {
  const a = (row.answerRaw || "").trim();
  if (!a) return null;
  if (/^[1-4]$/.test(a)) return Number(a);
  const norm = (s) => String(s || "").trim().toLowerCase();
  const an = norm(a);
  for (let n = 1; n <= 4; n++) {
    if (norm(row[`option${n}`]) === an) return n;
  }
  return null;
}

const IMPORT_CHUNK = 300;

function ImportModal({ onClose, onImported, staff }) {
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState([]); // [{ payload, errors, included }]
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(""); setResult(null); setPreview([]);
    setParsing(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // header: 1 -> array of arrays, so we control the header match ourselves
      // (same loose matching as the Applications CSV import) rather than
      // trusting the sheet's exact header spelling.
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      if (!aoa.length) { setError("Is file me koi data nahi mila."); setParsing(false); return; }
      const headers = aoa[0];
      const dataRows = aoa.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));
      if (!dataRows.length) { setError("Header ke alawa koi row nahi mili."); setParsing(false); return; }
      const built = dataRows.map((raw) => {
        const row = mapRow(headers, raw);
        const answer = resolveAnswer(row);
        const errors = [];
        if (!row.question) errors.push("Question khali hai");
        if (!row.option1 || !row.option2 || !row.option3) errors.push("Option 1-3 me se koi khali hai");
        if (answer && !row[`option${answer}`]) errors.push("Answer wale option ka text khali hai");
        if (!answer) errors.push("Answer 1-4 me samajh nahi aaya");
        const srNoRaw = row.qno || row.sno;
        return {
          errors,
          included: errors.length === 0,
          payload: {
            question: row.question || "", option1: row.option1 || "", option2: row.option2 || "",
            option3: row.option3 || "", option4: row.option4 || "", answer: answer || null,
            chapter: row.chapter || null,
            sr_no: srNoRaw && /^\d+$/.test(srNoRaw) ? Number(srNoRaw) : null,
          },
        };
      });
      setPreview(built);
    } catch (err) {
      setError("Ye file padhi nahi gayi: " + err.message);
    } finally {
      setParsing(false);
    }
  };

  const toggle = (i) => setPreview((rs) => rs.map((r, idx) => (idx === i ? { ...r, included: !r.included } : r)));
  const includedRows = preview.filter((r) => r.included && r.errors.length === 0);
  const errorCount = preview.filter((r) => r.errors.length > 0).length;

  const runImport = async () => {
    if (!includedRows.length) return;
    setImporting(true);
    setProgress({ done: 0, total: includedRows.length });
    let imported = 0;
    const failures = [];
    for (let i = 0; i < includedRows.length; i += IMPORT_CHUNK) {
      const chunk = includedRows.slice(i, i + IMPORT_CHUNK).map((r) => {
        const p = { ...r.payload };
        if (staff?.id) p.created_by = staff.id;
        return p;
      });
      const { error: err } = await supabase.from("question_bank").insert(chunk);
      if (err) failures.push({ range: `${i + 1}-${i + chunk.length}`, message: err.message });
      else imported += chunk.length;
      setProgress({ done: Math.min(i + IMPORT_CHUNK, includedRows.length), total: includedRows.length });
    }
    setImporting(false);
    setResult({ imported, failures });
    if (imported > 0) onImported();
  };

  return (
    <Modal title="Upload Question Bank (CSV / Excel)" onClose={onClose} size="xl">
      {!preview.length && !result ? (
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
            File me ye columns honi chahiye (naam thoda idhar-udhar bhi chal jayega): <b>Question</b>, <b>Option 1-4</b>, <b>Answer</b> (1-4). <b>S.No / Q.No</b> aur <b>Chapter</b> bhi rakh sakte hain, woh save ho jayenge.
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
            Agar kisi cell me image ka seedha URL (http…, .jpg/.png) ho to wo app me image ki tarah dikhega — Excel me upar se chipkaai hui (floating) picture is tarah nahi aayegi, sirf text/URL wale cell aate hain.
          </p>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="block w-full text-sm text-slate-600 dark:text-slate-300" />
          {parsing && <p className="text-sm text-slate-400 mt-2">Padh raha hoon…</p>}
          {error && <p className="text-rose-500 text-sm mt-2">{error}</p>}
        </div>
      ) : result ? (
        <div>
          <p className="text-sm text-slate-700 dark:text-slate-200 mb-2">
            <span className="font-semibold text-emerald-600">{result.imported}</span> question{result.imported !== 1 ? "s" : ""} import ho gaye.
          </p>
          {result.failures.length > 0 && (
            <div className="rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900/40 p-3 text-xs text-rose-600 dark:text-rose-400">
              {result.failures.map((f, i) => <div key={i}>Rows {f.range}: {f.message}</div>)}
            </div>
          )}
          <div className="flex justify-end mt-4"><PrimaryButton onClick={onClose}>Done</PrimaryButton></div>
        </div>
      ) : (
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
            {fileName} — {preview.length} rows mile, <span className="font-semibold text-emerald-600">{includedRows.length}</span> import ke liye tayyar
            {errorCount > 0 && <span className="text-rose-500"> · {errorCount} rows me gadbad hai (neeche laal me)</span>}.
          </p>
          <div className="max-h-[50vh] overflow-auto border border-slate-200 dark:border-slate-800 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left w-8"></th>
                  <th className="px-2 py-1.5 text-left">Question</th>
                  <th className="px-2 py-1.5 text-left">Option 1</th>
                  <th className="px-2 py-1.5 text-left">Option 2</th>
                  <th className="px-2 py-1.5 text-left">Option 3</th>
                  <th className="px-2 py-1.5 text-left">Option 4</th>
                  <th className="px-2 py-1.5 text-left">Answer</th>
                  <th className="px-2 py-1.5 text-left">Problem</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className={`border-t border-slate-100 dark:border-slate-800 ${r.errors.length ? "bg-rose-50/60 dark:bg-rose-950/10" : ""}`}>
                    <td className="px-2 py-1.5"><input type="checkbox" checked={r.included} disabled={r.errors.length > 0} onChange={() => toggle(i)} /></td>
                    <td className="px-2 py-1.5 max-w-[220px] truncate" title={r.payload.question}>{r.payload.question || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[140px] truncate">{r.payload.option1 || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[140px] truncate">{r.payload.option2 || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[140px] truncate">{r.payload.option3 || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[140px] truncate">{r.payload.option4 || "—"}</td>
                    <td className="px-2 py-1.5">{r.payload.answer || "—"}</td>
                    <td className="px-2 py-1.5 text-rose-500">{r.errors.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {importing && progress && (
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">Import ho raha hai… {progress.done} / {progress.total}</p>
          )}
          <div className="flex items-center justify-end gap-2 mt-3">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={runImport} disabled={importing || !includedRows.length}>
              {importing ? "Importing…" : `Import ${includedRows.length} question${includedRows.length !== 1 ? "s" : ""}`}
            </PrimaryButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
