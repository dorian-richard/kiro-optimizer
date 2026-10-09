import { describe, expect, it } from 'vitest';
import { analyzeCommand } from '../src/hooks/commands.js';

describe('analyzeCommand', () => {
  const kind = (c: string) => analyzeCommand(c).kind;

  it('recognizes verbose test runs across stacks', () => {
    for (const c of [
      'mvn test', './mvnw -q verify', 'gradle test', './gradlew :app:check', 'npm test', 'npm run test:unit', 'yarn test',
      'pnpm test -- --run', 'pnpm run e2e', 'bun test', 'npx jest src/a.test.ts', 'vitest run', 'pytest -x tests/',
      'python -m pytest', 'python3 -m unittest discover', 'go test ./...', 'dotnet test', 'cargo test', 'make test',
      'CI=1 npm test', 'time pytest', 'poetry run pytest', 'uv run pytest -q', 'bundle exec rspec', 'npx playwright test',
      'npx nx test api', 'turbo run test', 'python manage.py test', 'tox -e py311', 'cd backend && mvn -B test',
    ]) expect(kind(c), c).toBe('test');
  });

  it('recognizes verbose builds', () => {
    for (const c of ['mvn package', 'gradle build', 'npm run build', 'yarn build', 'pnpm build', 'tsc --noEmit', 'npx tsc -p .',
      'dotnet build', 'cargo build --release', 'cargo clippy', 'go build ./...', 'make', 'make all', 'cmake --build build']) {
      expect(kind(c), c).toBe('build');
    }
  });

  it('ignores ordinary commands and version probes', () => {
    for (const c of ['git status', 'ls -la', 'npm install', 'yarn', 'pnpm add zod', 'cat package.json', 'mvn -v', 'gradle --version',
      'tsc --version', 'go mod tidy', 'cargo fmt', 'make clean', 'python script.py', 'npm run dev', 'echo test', 'grep -r build .']) {
      expect(kind(c), c).toBeUndefined();
    }
  });

  it('extracts a cd prefix and normalizes whitespace in the key', () => {
    const a = analyzeCommand('cd services/api &&   npm   test');
    expect(a.cdDir).toBe('services/api');
    expect(a.core).toBe('npm   test');
    expect(a.key).toBe('services/api|npm test');
    expect(analyzeCommand('npm test').key).not.toBe(a.key);
    expect(analyzeCommand('npm test && npm run build').kind).toBe('test');
  });

  it('understands PowerShell and cmd.exe spellings (Windows)', () => {
    for (const c of ["& npm test", "& 'C:\\r\\gradlew.bat' test", 'gradlew.bat build', '.\\mvnw.cmd verify', 'npm.ps1 test', 'pnpm.cmd run build']) {
      expect(kind(c), c).toBeDefined();
    }
    for (const [c, dir] of [
      ['Set-Location backend; npm test', 'backend'],
      ['sl "my app" ; npm test', 'my app'],
      ['cd /d C:\\work\\api && npm test', 'C:\\work\\api'],
      ['chdir api && npm test', 'api'],
      ['Push-Location api; dotnet test', 'api'],
    ] as const) {
      const a = analyzeCommand(c);
      expect(a.cdDir, c).toBe(dir);
      expect(a.kind, c).toBe('test');
    }
  });
});
