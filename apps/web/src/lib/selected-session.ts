import { useSyncExternalStore } from "react";

const key = "loopmarshal.selectedSession";
const eventName = "loopmarshal:session-selected";
const read = () => localStorage.getItem(key);
const subscribe = (notify: () => void) => {
  window.addEventListener(eventName, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(eventName, notify);
    window.removeEventListener("storage", notify);
  };
};

export function useSelectedSession() {
  const sessionId = useSyncExternalStore(subscribe, read, () => null);
  return [
    sessionId,
    (id: string | null) => {
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
      window.dispatchEvent(new Event(eventName));
    },
  ] as const;
}
