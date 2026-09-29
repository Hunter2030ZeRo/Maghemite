import {
  MAX_EDITOR_GROUPS,
  MAX_EDITOR_TABS,
  type EditorGroup,
  type GroupSession,
  type Session,
  type ViewTab,
} from "./model.ts";

export function groupedSession(session: Session): GroupSession {
  if (session.version === 2) return session;
  return {
    ...session,
    version: 2,
    groups: [{
      id: "group:main",
      tabs: session.tabs.map((tab) => tab.id),
      activeTab: session.activeTab ?? session.tabs[0]?.id ?? null,
      size: 1,
    }],
    activeGroup: "group:main",
    activeTab: session.activeTab ?? session.tabs[0]?.id ?? null,
  };
}

function withGroups(session: GroupSession, groups: EditorGroup[], activeGroup = session.activeGroup): GroupSession {
  return {
    ...session, groups, activeGroup,
    activeTab: groups.find((group) => group.id === activeGroup)?.activeTab ?? null,
  };
}

export function focusGroup(session: GroupSession, id: string): GroupSession {
  return session.groups.some((group) => group.id === id)
    ? withGroups(session, session.groups, id) : session;
}

export function activateView(session: GroupSession, id: string): GroupSession {
  const group = session.groups.find((group) => group.tabs.includes(id));
  if (!group) return session;
  return withGroups(session, session.groups.map((item) =>
    item.id === group.id ? { ...item, activeTab: id } : item), group.id);
}

export function addView(session: GroupSession, tab: ViewTab, groupId = session.activeGroup): GroupSession {
  if (session.tabs.length >= MAX_EDITOR_TABS ||
    !session.groups.some((group) => group.id === groupId)) return session;
  return withGroups({
    ...session, tabs: [...session.tabs, tab],
  }, session.groups.map((group) => group.id === groupId
    ? { ...group, tabs: [...group.tabs, tab.id], activeTab: tab.id } : group), groupId);
}

export function closeView(session: GroupSession, id: string): GroupSession {
  return withGroups({
    ...session, tabs: session.tabs.filter((tab) => tab.id !== id),
  }, session.groups.map((group) => {
    const index = group.tabs.indexOf(id);
    if (index < 0) return group;
    const tabs = group.tabs.filter((tab) => tab !== id);
    return { ...group, tabs, activeTab: group.activeTab === id
      ? tabs[Math.min(index, tabs.length - 1)] ?? null : group.activeTab };
  }));
}

export function splitGroup(session: GroupSession, groupId: string, newGroupId: string, newViewId: string): GroupSession {
  if (session.groups.length >= MAX_EDITOR_GROUPS || session.tabs.length >= MAX_EDITOR_TABS) return session;
  const group = session.groups.find((group) => group.id === groupId);
  if (!group) return session;
  const current = session.tabs.find((tab) => tab.id === group.activeTab);
  const copy = current?.type === "document"
    ? { ...current, id: newViewId, view: current.view ? {
      ...current.view,
      editor: current.view.editor ? {
        ...current.view.editor,
        selections: current.view.editor.selections.map((selection) => ({ ...selection })),
      } : undefined,
    } : undefined }
    : undefined;
  const next: EditorGroup = {
    id: newGroupId, tabs: copy ? [copy.id] : [],
    activeTab: copy?.id ?? null, size: group.size / 2,
  };
  return withGroups({
    ...session, tabs: copy ? [...session.tabs, copy] : session.tabs,
  }, session.groups.flatMap((item) => item.id === group.id
    ? [{ ...item, size: item.size / 2 }, next] : [item]), next.id);
}

export function moveView(session: GroupSession, id: string, destination: string): GroupSession {
  const source = session.groups.find((group) => group.tabs.includes(id));
  if (!source || source.id === destination ||
    !session.groups.some((group) => group.id === destination)) return session;
  const without = closeView(session, id);
  return withGroups({ ...without, tabs: session.tabs }, without.groups.map((group) =>
    group.id === destination ? { ...group, tabs: [...group.tabs, id], activeTab: id } : group), destination);
}

/** Closing a group collects its views; it is never a discard-draft operation. */
export function closeGroup(session: GroupSession, id: string): GroupSession {
  if (session.groups.length === 1) return session;
  const index = session.groups.findIndex((group) => group.id === id);
  if (index < 0) return session;
  const source = session.groups[index], destination = session.groups[index ? index - 1 : 1];
  const groups = session.groups.filter((group) => group.id !== id).map((group) =>
    group.id === destination.id ? {
      ...group, tabs: [...group.tabs, ...source.tabs], size: group.size + source.size,
      activeTab: session.activeGroup === id ? source.activeTab ?? group.activeTab : group.activeTab,
    } : group);
  return withGroups(session, groups, session.activeGroup === id ? destination.id : session.activeGroup);
}

export function resizeGroups(session: GroupSession, id: string, size: number): GroupSession {
  const index = session.groups.findIndex((group) => group.id === id);
  const left = session.groups[index], right = session.groups[index + 1];
  if (!left || !right || !Number.isFinite(size)) return session;
  const total = left.size + right.size;
  const next = Math.max(total * 0.1, Math.min(total * 0.9, size));
  return withGroups(session, session.groups.map((group) =>
    group.id === left.id ? { ...group, size: next } :
    group.id === right.id ? { ...group, size: total - next } : group));
}

/** Runtime module tabs cannot outlive the contribution that owns them. */
export function recoverableSession(session: GroupSession): GroupSession {
  let result = session;
  for (const tab of session.tabs) if (tab.type === "custom") result = closeView(result, tab.id);
  return result;
}
