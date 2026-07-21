// Typed wrapper over the shared item-translation core (plain JS, declared untyped via shared.d.ts).
import { listLanguages as _list, loadItemNames as _load, languageLabel as _label } from '@shared/translations.js';

// Display-name lookup for one language. get() returns a translated name, or null to fall back to
// the raw item/model name.
export interface DisplayNames {
  lang: string;
  size: number;
  get(name: string, modName?: string | null): string | null;
}

// Both take the whole asset index (they use index.sources for translation files and, for the
// loader, index.scriptFiles for the English DisplayName fallback).
export const listLanguages = (index: unknown): Promise<string[]> => _list(index);
export const loadItemNames = (index: unknown, lang: string): Promise<DisplayNames> => _load(index, lang);
export const languageLabel = (code: string): string => _label(code);
