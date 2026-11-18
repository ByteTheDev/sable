import type { App } from '../app';
import { registerBackdrop } from './backdrop';
import { registerConfig } from './config';
import { registerDevice } from './device';
import { registerFiles } from './files';
import { registerFs } from './fs';
import { registerGit } from './git';
import { registerMemory } from './memory';
import { registerTerm } from './term';
import { registerUsage } from './usage';

export interface ServiceOptions {
  /** User home for fs.roots and user-scope memory files (defaults to os.homedir(); tests override it). */
  userHome?: string;
}

/** Registers workspace services (files, git, terminal, memory) on the app. */
export function registerServices(app: App, opts: ServiceOptions = {}) {
  registerFs(app, { home: opts.userHome });
  registerFiles(app);
  registerGit(app);
  registerTerm(app);
  registerMemory(app, { home: opts.userHome });
  registerConfig(app, { home: opts.userHome });
  registerBackdrop(app);
  registerUsage(app, { home: opts.userHome });
  registerDevice(app);
}
