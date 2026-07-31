import { type ChatProvider, codexPricingFor, findChatModel, type ModelPricing } from "../contracts";

// The rate card a turn is costed at. `fast` selects the provider's fast-mode
// card where the catalog has one, falling back to the standard rates rather
// than refusing to price: understating a premium beats reporting nothing.
export function pricingFor(
  provider: ChatProvider,
  modelId: string,
  fast = false,
): ModelPricing | undefined {
  if (provider === "anthropic") {
    const model = findChatModel(modelId);
    return (fast ? model?.fastPricing : undefined) ?? model?.pricing;
  }
  return codexPricingFor(modelId, fast);
}
