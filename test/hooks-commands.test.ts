import { describe, expect, it } from 'vitest';
import { analyzeCommand, isReadOnlyCommand } from '../src/hooks/commands.js';

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

  it('marks only predictably verbose runs as verbose (worth a redirect to kopt_run)', () => {
    const verbose = (c: string) => analyzeCommand(c).verbose;
    for (const c of ['mvn test', './mvnw -B verify', './gradlew build', 'mvn test -Dtest=OrderTest', 'npm test', 'yarn test', 'pnpm run build', 'pytest', 'pytest -x tests/',
      'python -m pytest', 'go test ./...', 'cargo test', 'cargo build --release', 'dotnet test', 'dotnet build', 'make', 'make test',
      'npx jest', 'npx vitest run', 'bundle exec rspec', 'python manage.py test', 'npx nx test api', 'xcodebuild test']) {
      expect(verbose(c), c).toBe(true);
    }
    for (const c of ['tsc --noEmit', 'npx tsc -p .', 'go vet ./...', 'go build ./...', 'go test ./pkg/orders', 'pytest tests/test_api.py',
      'pytest -k refund', 'python -m pytest tests/test_api.py::test_refund', 'npx jest src/a.test.ts', 'npm test -- src/a.test.ts',
      'npx vitest run src/a.spec.ts', 'mvn -q test -Dtest=OrderTest', './gradlew -q test --tests OrderTest', 'mvn -q compile', 'npm run typecheck',
      'npm run lint', 'dotnet test --filter Name=Refund', 'python manage.py test orders.tests.RefundTest', 'git status']) {
      expect(verbose(c), c).toBe(false);
    }
  });

  it('never treats watch modes, dev servers or run goals as test/build runs', () => {
    for (const c of ['./gradlew bootRun', 'gradle run', 'mvn spring-boot:run', 'mvn jetty:run', 'mvn quarkus:dev', 'mvn exec:java', 'tsc --watch',
      'tsc -w -p .', 'npm run build:watch', 'npm run build -- --watch', 'npm run dev', 'npm start', 'yarn dev', 'pnpm serve', 'npm run start:prod',
      'npm test -- --watch', 'npx jest --watchAll', 'ng serve', 'ng test', 'dotnet run', 'dotnet watch test', 'cargo run', 'go run .',
      'python manage.py runserver', 'npx vite', 'webpack serve', 'make run', './gradlew test --continuous', 'npm test &']) {
      const a = analyzeCommand(c);
      expect([c, a.kind, a.longRunning]).toEqual([c, undefined, true]);
    }
    expect(analyzeCommand('ng test --watch=false').kind).toBe('test');
    expect(analyzeCommand('npm run build:dev').kind).toBe('build');
    expect(analyzeCommand('pytest -W error').longRunning).toBe(false);
  });

  it('treats every command kopt_run refuses as long-running, so the governor never redirects to a refusal', () => {
    for (const c of ['pytest -f', 'pytest --looponfail', 'python -m pytest -f', 'npm test -- --hot', 'docker compose up', 'tail -f build.log',
      'kubectl logs -f deploy/api', 'php artisan serve']) {
      const a = analyzeCommand(c);
      expect([c, a.kind, a.verbose, a.longRunning]).toEqual([c, undefined, false, true]);
    }
    for (const c of ['pytest', 'npm test', 'mvn test', 'go test ./...', 'docker compose up -d && npm test']) {
      expect([c, analyzeCommand(c).longRunning]).toEqual([c, false]);
    }
  });

  it('knows which shell commands only read the workspace', () => {
    for (const c of ['ls -la', 'cat a.txt | grep x', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'find . -name "*.ts"', 'rg foo src',
      'head -50 a.py', 'pwd && ls', 'echo hello', 'cd src && ls', 'Get-ChildItem', 'git branch', 'wc -l a.txt 2>&1', 'grep x a >/dev/null']) {
      expect(isReadOnlyCommand(c), c).toBe(true);
    }
    for (const c of ['sed -i s/a/b/ a.txt', 'git checkout -- a.txt', 'git stash', 'git apply p.diff', 'npm install', 'pip install x', 'echo x > a.txt',
      'cat a >> b', 'rm a.txt', 'mv a b', 'npx prettier --write .', 'touch x', 'git branch -D old', 'python gen.py', 'make generate']) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });
});
