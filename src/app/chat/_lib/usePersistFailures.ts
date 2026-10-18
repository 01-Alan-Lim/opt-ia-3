// src/app/chat/_lib/usePersistFailures.ts
//
// Estado de los mensajes que no se pudieron guardar (ver persistFailures.ts). La lista vive en
// un ref para que la cola se consulte en el momento (dos guardados seguidos ven el mismo
// estado) y se copia al estado de React para pintar el aviso.

import { useCallback, useRef, useState } from "react";

import type { PersistMessageInput, PersistMessageResult } from "./advisorApi";
import {
  blocksChat,
  dismissRejected,
  queueBehind,
  recordFailure,
  retryPending,
  type PersistFailure,
} from "./persistFailures";

type FailedResult = Extract<PersistMessageResult, { ok: false }>;

const newId = () => crypto.randomUUID();

export function usePersistFailures() {
  const listRef = useRef<PersistFailure[]>([]);
  const retryingRef = useRef(false);
  const [failures, setFailures] = useState<PersistFailure[]>([]);
  const [retrying, setRetrying] = useState(false);

  const commit = useCallback((next: PersistFailure[]) => {
    listRef.current = next;
    setFailures(next);
  }, []);

  const blocks = useCallback((chatId: string) => blocksChat(listRef.current, chatId), []);

  const report = useCallback(
    (input: PersistMessageInput, result: FailedResult) => commit(recordFailure(listRef.current, input, result, newId)),
    [commit],
  );

  const queue = useCallback((input: PersistMessageInput) => commit(queueBehind(listRef.current, input, newId)), [commit]);

  // Un reintento a la vez; lo que llegue mientras tanto queda detrás.
  const retry = useCallback(
    async (send: (input: PersistMessageInput) => Promise<PersistMessageResult>) => {
      if (retryingRef.current) return;
      retryingRef.current = true;
      setRetrying(true);
      try {
        const attempted = listRef.current;
        const remaining = await retryPending(attempted, send);
        const added = listRef.current.filter((failure) => !attempted.includes(failure));
        commit([...remaining, ...added]);
      } finally {
        retryingRef.current = false;
        setRetrying(false);
      }
    },
    [commit],
  );

  const dismiss = useCallback(() => commit(dismissRejected(listRef.current)), [commit]);

  return { failures, retrying, blocks, report, queue, retry, dismiss };
}
