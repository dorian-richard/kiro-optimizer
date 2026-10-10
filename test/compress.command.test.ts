// Command classification: commands that never exit (refused by kopt_run) and commands whose result may be cached.

import { describe, expect, it } from 'vitest';
import { isCacheableCommand, longRunningReason } from '../src/compress/index.js';

describe('longRunningReason', () => {
  it.each([
    'npm run dev',
    'npm start',
    'npm run start:dev',
    'npm run test:watch',
    'npm run build -- --watch',
    'yarn dev',
    'pnpm dev',
    'bun run dev',
    'npx vite',
    'vite preview',
    'npx next dev',
    'ng serve',
    'ng test',
    'npx tsc --watch',
    'tsc -w -p .',
    'tsc -b --watch',
    'npx jest --watch',
    'jest --watchAll',
    'vitest watch',
    'vitest --watch',
    'webpack serve',
    'webpack -w',
    'node --watch app.js',
    'nodemon server.js',
    './gradlew bootRun',
    './gradlew :app:bootRun',
    'gradle run',
    'gradle build --continuous',
    'gradle test -t',
    'mvn spring-boot:run',
    './mvnw quarkus:dev',
    'mvn jetty:run',
    'sbt ~test',
    'python manage.py runserver',
    'flask run',
    'uvicorn app.main:app --reload',
    'python -m http.server 8000',
    'bin/rails server',
    'bundle exec rails s',
    'php artisan serve',
    'php -S localhost:8000',
    'dotnet watch test',
    'cargo watch -x test',
    'docker compose up',
    'docker-compose up --build',
    'kubectl logs -f deploy/api',
    'kubectl port-forward svc/api 8080:80',
    'tail -f build.log',
    'celery -A proj worker',
    'cd web && npm run dev',
    'ng serve --no-watch',
    'npx @11ty/eleventy --serve',
  ])('%s never exits', (cmd) => {
    expect(longRunningReason(cmd)).toBeTruthy();
  });

  it.each([
    'npm test',
    'npm run build',
    'npm run build:dev',
    'npm test -w packages/api',
    'npm run test -- --watch=false',
    'npx jest --watchAll=false',
    'npx jest -w 4',
    'jest --ci',
    'vitest',
    'npx vitest run',
    'vite build',
    'next build',
    'next lint',
    'ng test --watch=false',
    'ng test --no-watch',
    'ng build',
    'tsc --noEmit',
    'tsc -b',
    './gradlew test',
    'gradle build',
    'mvn -q test',
    'mvn spring-boot:build-image',
    'sbt test',
    'python manage.py test',
    'pytest -x',
    'dotnet test',
    'dotnet run',
    'cargo test',
    'go test ./...',
    'docker compose up -d',
    'docker compose logs api',
    'kubectl get pods',
    'tail -n 50 build.log',
    'git log --follow -- src/a.ts',
    'grep -w foo src',
    'curl -w "%{http_code}" http://localhost:3000',
    'timeout 30 npm run dev',
    'npm run dev & sleep 5 && curl localhost:3000',
    "& .\\gradlew.bat test",
    'symfony server:start -d',
  ])('%s exits by itself', (cmd) => {
    expect(longRunningReason(cmd)).toBeUndefined();
  });

  it('names the reason in a few words', () => {
    expect(longRunningReason('npm run dev')).toBe('script "dev" usually runs until stopped');
    expect(longRunningReason('npx tsc --watch')).toBe('--watch never exits');
    expect(longRunningReason('ng test')).toBe('ng test watches by default (add --watch=false)');
    expect(longRunningReason('./gradlew bootRun')).toBe('run task runs until stopped');
  });
});

describe('isCacheableCommand', () => {
  it.each([
    'npm test',
    'npm test -w packages/api',
    'npx jest -w 4',
    'bazel test //...',
    'sbt test',
    'sbt "testOnly com.acme.FooSpec"',
    'bundle exec rspec',
    'vendor/bin/phpunit',
    'php artisan test',
    'npx mocha',
    'rake test',
    'golangci-lint run',
  ])('%s may be answered from cache', (cmd) => {
    expect(isCacheableCommand(cmd)).toBe(true);
  });

  it.each(['npm run dev', 'npx jest --watch', 'bazel run //app', 'sbt run', 'sbt publish', 'php artisan migrate', 'rake db:migrate', 'make test'])(
    '%s is never cached',
    (cmd) => {
      expect(isCacheableCommand(cmd)).toBe(false);
    },
  );
});
