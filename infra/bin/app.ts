#!/usr/bin/env node
// CDK entry point: `npx cdk synth` (see infra/README.md for context keys).
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { buildKopt } from '../lib/stacks.js';

const app = new App();
buildKopt(app, {
  repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
  infraDir: fileURLToPath(new URL('..', import.meta.url)),
});
app.synth();
