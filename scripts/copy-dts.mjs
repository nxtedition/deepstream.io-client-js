import { cpSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

function copyDts(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyDts(join(srcDir, entry.name), join(destDir, entry.name))
    } else if (entry.name.endsWith('.d.ts')) {
      mkdirSync(destDir, { recursive: true })
      cpSync(join(srcDir, entry.name), join(destDir, entry.name))
      rmSync(join(destDir, entry.name + '.map'), { force: true })
    }
  }
}

copyDts('src', 'lib')
