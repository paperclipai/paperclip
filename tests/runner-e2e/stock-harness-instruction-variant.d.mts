export interface StockInstructionVariant {
  variant: "reduced" | "historical";
  sha256: string;
  content: string;
}
export function classifyStockInstructionManual(content: unknown): StockInstructionVariant;
export function readStockInstructionVariant(): StockInstructionVariant;
