// src/lib/types.ts

import type { MessageRole } from "@/lib/chat/messageProvenance";

// user, assistant o advisor: ver src/lib/chat/messageProvenance.ts.
export type Role = MessageRole;

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string; // ISO string
}
