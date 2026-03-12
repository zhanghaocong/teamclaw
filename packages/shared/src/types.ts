export type CardStatus = "todo" | "running" | "review" | "done";

export interface Card {
  id: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  status: CardStatus;
}

export interface RunSummary {
  id: string;
  cardId: string;
  startedAt: string;
  finishedAt?: string;
  approval: "approved" | "changes_requested" | "pending";
}
