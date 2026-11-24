// The built-in subcommands. Each area adds its CommandDef here
// (runs, gate, skill, doctor, ignore, trust, init, login, logout).
import type { CommandDef } from './command.js'
import { gateCommand } from './gate.js'
import { doctorCommand } from './doctor.js'
import { ignoreCommand } from './ignore.js'
import { initCommand } from './init.js'
import { loginCommand } from './login.js'
import { logoutCommand } from './logout.js'
import { reviewCommand } from './review.js'
import { runsCommand } from './runs.js'
import { skillCommand } from './skill.js'
import { trustCommand } from './trust.js'

export const builtinCommands:readonly CommandDef[] = [
    doctorCommand,
    reviewCommand,
    runsCommand,
    skillCommand,
    gateCommand,
    ignoreCommand,
    initCommand,
    loginCommand,
    logoutCommand,
    trustCommand,
]
