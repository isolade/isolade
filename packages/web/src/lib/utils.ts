import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ChatEffort } from "./contracts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "xhigh" reads better as "Extra" in a menu; everything else just
// capitalizes its single token.
export function effortLabel(effort: ChatEffort): string {
  if (effort === "xhigh") return "Extra";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
