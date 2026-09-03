import { cp, rm } from 'node:fs/promises';

await rm('dist/dashboard', { recursive: true, force: true });
await cp('dashboard/dist', 'dist/dashboard', { recursive: true });