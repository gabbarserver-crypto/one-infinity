// src/pages/Chats.jsx
//
// The full-page "Expand" destination for the floating CommsWindow — same
// four tabs (Recent Chats / Recent Calls / New Call / Customer Chat), same
// data and row components (ThreadsTab / CallsTab / NewCallTab, all reused
// straight from CommsWindow.jsx), just laid out as top tabs + a big
// two-pane inbox instead of a small popup with a bottom nav. Keeps the
// desktop "Chats" page and the floating chat window looking and behaving
// identically, with one shared implementation.
import React, { useState } from "react";
import ChatPanel from "../components/ChatPanel";
import CallLogPanel from "../components/CallLogPanel";
import { identityFor } from "../lib/chat";
import { ThreadsTab, CallsTab, NewCallTab, TABS } from "../components/CommsWindow";
import { usePresence, statusOfDealer } from "../lib/presence";
import { StatusLine } from "../components/Presence";

export default function Chats({ staff, call }) {
  const [tab, setTab] = useState("chats");
  const [selectedThread, setSelectedThread] = useState(null); // { threadId, dealerId, applicationId, label, dealerName } | null

  const identity = identityFor({ staff });
  const presenceSnap = usePresence();
  const threadStatus = selectedThread ? statusOfDealer(presenceSnap, selectedThread.dealerId) : null;

  // Opening a thread hands it to <ChatPanel/>, which marks it read
  // server-side as soon as it mounts — ThreadsTab's own badge refetches on
  // that same event (see lib/threadReadBus.js).
  const openThread = (thread) => setSelectedThread(thread);

  const changeTab = (key) => {
    setTab(key);
    setSelectedThread(null);
  };

  return (
    <div className="max-w-6xl">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Chats</h1>
        <p className="text-sm text-slate-500 dark:text-slate-500">Every conversation, call, and contact, in one inbox.</p>
      </div>

      <div className="flex gap-2 mb-4">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => changeTab(key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-semibold border flex items-center gap-1.5 ${
              tab === key
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-[340px_1fr] gap-4" style={{ height: "72vh" }}>
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
          {tab === "chats" ? (
            <ThreadsTab variant="staff" scope="general" onOpenThread={openThread} onScopeChange={changeTab} onNewCall={() => changeTab("new")} />
          ) : tab === "unread" ? (
            <ThreadsTab variant="staff" scope="unread" onOpenThread={openThread} onScopeChange={changeTab} onNewCall={() => changeTab("new")} />
          ) : tab === "customer" ? (
            <ThreadsTab variant="staff" scope="application" onOpenThread={openThread} />
          ) : tab === "calls" ? (
            <CallsTab variant="staff" identity={identity} call={call} onOpenThread={openThread} />
          ) : (
            <>
              <button onClick={() => changeTab("chats")} className="text-sm font-semibold text-emerald-600 hover:text-emerald-700 px-4 pt-3 text-left shrink-0">
                ← Back to chats
              </button>
              <NewCallTab variant="staff" identity={identity} call={call} onOpenThread={openThread} />
            </>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
              {selectedThread ? selectedThread.label : "Select a conversation"}
            </h3>
            {selectedThread && (
              <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
                {selectedThread.dealerName}
                {selectedThread.dealerName && (threadStatus.online || threadStatus.lastSeen) ? " · " : ""}
                <StatusLine status={threadStatus} />
              </p>
            )}
          </div>
          {selectedThread ? (
            <>
              <CallLogPanel threadId={selectedThread.threadId} dealerId={selectedThread.dealerId} />
              <ChatPanel
                dealerId={selectedThread.dealerId}
                applicationId={selectedThread.applicationId}
                identity={identity}
                emptyLabel="No messages here yet."
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-400 dark:text-slate-500">
              Pick a conversation on the left to view and reply.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
