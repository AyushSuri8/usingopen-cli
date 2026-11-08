/**
 * ArkType compatibility facade — `@usingopen/omptype/ark`.
 *
 * Lets code written against arktype keep its imports and names while running
 * on the omptype lazy-JIT runtime: swap `from "arktype"` for
 * `from "@usingopen/omptype/ark"` and nothing else changes. New code should
 * import `@usingopen/omptype` directly.
 *
 * Compatibility affordance: `ArkError` / `ArkErrors` alias `UsingopenError` /
 * `UsingopenErrors`. All schema builders, including recursive `scope()`, are
 * re-exported unchanged.
 */
import { UsingopenError, UsingopenErrors } from "./errors";

export * from "./index";

export const ArkError = UsingopenError;
export type ArkError = UsingopenError;
export const ArkErrors = UsingopenErrors;
export type ArkErrors = UsingopenErrors;
