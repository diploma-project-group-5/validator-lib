// The purity of the domain layer, checked on the source text. It reads src/ as written, so the
// mutation run (vitest.stryker.config.ts) leaves it out: instrumented files are not the source.
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('architecture', () => {
  it('the domain imports neither the boundary, the CLI nor Node APIs', () => {
    const dir = new URL('../src/domain/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/from ['"](node:|\.\.\/boundary|\.\.\/cli)/);
      expect(src, f).not.toMatch(/\b(Date|Math\.random|process|console)\b/);
    }
  });
});
