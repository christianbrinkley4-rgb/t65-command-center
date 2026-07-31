// Agent phone numbers (from the dialer's agents.json — these are phone numbers,
// not secrets). Used as the "ring me first" leg of a bridge call.
export const AGENT_PHONES: Record<string, string> = {
  Christian: "+19194086671",
  Will: "+13367402604",
};

export function agentPhone(me: string): string {
  return AGENT_PHONES[me] || AGENT_PHONES.Christian;
}
