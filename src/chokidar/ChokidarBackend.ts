import {Event, FilePath, Options, SubscribeCallback} from '../..';
import {watch, FSWatcher} from 'chokidar';
import fs from 'fs';
import path from 'path';
import {minimatch} from 'minimatch';

const watchers = new Map<SubscribeCallback, Map<string, FSWatcher>>();

async function getTree(filePath: string) {
  const entries = new Map<string, {mtime: number; isDir: boolean}>();

  try {
    const fileStat = await fs.promises.stat(filePath);
    const isDir = fileStat.isDirectory();
    entries.set(filePath, {mtime: +fileStat.mtime, isDir});

    if (isDir) {
      const files = await fs.promises.readdir(filePath);
      for (const file of files) {
        for (const [_filePath, entry] of await getTree(
          path.join(filePath, file),
        )) {
          entries.set(_filePath, entry);
        }
      }
    }
  } catch {}
  return entries;
}

export class ChokidarBackend {
  async subscribe(dir: FilePath, fn: SubscribeCallback, opts?: Options) {
    const watcher = watch(dir, {
      ignored: opts?.ignore,
    });

    let dirWatchers = watchers.get(fn);
    if (!dirWatchers) {
      dirWatchers = new Map();
      watchers.set(fn, dirWatchers);
    }
    dirWatchers.set(dir, watcher);

    watcher.on('all', (event, path) => {
      const type =
        event === 'change'
          ? ('update' as const)
          : ['unlink', 'unlinkDir'].includes(event)
          ? ('delete' as const)
          : ('create' as const);

      fn(null, [{path, type}]);
    });

    watcher.on('error', (error) => {
      fn(error, []);
    });

    return () => watcher.close();
  }

  async unsubscribe(dir: FilePath, fn: SubscribeCallback, opts?: Options) {
    const watcher = watchers.get(fn)?.get(dir);

    await watcher?.close();
  }

  async writeSnapshot(dir: FilePath, snapshot: FilePath, opts?: Options) {
    let lines = '';

    for (const [path, {mtime, isDir}] of await getTree(dir)) {
      lines += `${path.length}${path}${mtime} ${+isDir}\n`;
    }

    fs.writeFileSync(snapshot, lines);
  }

  async getEventsSince(dir: FilePath, snapshot: FilePath, opts?: Options) {
    try {
      var lines = fs.readFileSync(snapshot, 'utf8').split('\n');
    } catch (e) {
      return [];
    }

    const prevPaths = new Set();
    const nowEntries = await getTree(dir);

    const events: Event[] = [];

    for (const line of lines) {
      const segments = line.split('/');
      const pathLength = parseInt(segments.shift()!);
      const rest = segments.join('/');

      const path = `/${rest.slice(0, pathLength - 1)}`;
      const mtimeAndIsDir = path.slice(pathLength).split(' ');
      const mtime = parseInt(mtimeAndIsDir[0]);
      const isDir = Boolean(+mtimeAndIsDir[1]);

      const now = nowEntries.get(path);

      if (!now) {
        events.push({
          path,
          type: 'delete',
        });
      } else {
        if (now.isDir !== isDir) {
          events.push({path, type: 'delete'}, {path, type: 'create'});
        } else if (now.mtime !== mtime) {
          events.push({path, type: 'update'});
        }
      }

      prevPaths.add(path);
    }

    for (const path of nowEntries.keys()) {
      if (!prevPaths.has(path)) {
        events.push({path, type: 'create'});
      }
    }

    return events;
  }
}
