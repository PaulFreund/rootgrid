<script setup>
import { computed } from 'vue'
import { Check, GitBranch, Loader2, Minus, Plus } from 'lucide-vue-next'

import { classifyWorkspaceGitEntries } from '../lib/workspaceGit.js'

const props = defineProps({
  cwd: {
    type: String,
    default: ''
  },
  status: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: String,
    default: ''
  },
  actionWorking: {
    type: Boolean,
    default: false
  },
  branchWorking: {
    type: Boolean,
    default: false
  },
  branchDraft: {
    type: String,
    default: ''
  }
})

const emit = defineEmits([
  'refresh',
  'open-file',
  'stage',
  'unstage',
  'switch-branch',
  'create-branch',
  'update:branchDraft'
])

const groups = computed(() => classifyWorkspaceGitEntries(props.status?.entries))
const branches = computed(() => Array.isArray(props.status?.branches) ? props.status.branches : [])
const changeStagePaths = computed(() => [...groups.value.changes, ...groups.value.untracked].map((entry) => entry.path))
const stagedPaths = computed(() => groups.value.staged.map((entry) => entry.path))

function updateDraft(event) {
  emit('update:branchDraft', event?.target?.value ?? '')
}

function createBranch() {
  emit('create-branch')
}

function switchBranch(name) {
  emit('switch-branch', name)
}

function stagePath(path) {
  emit('stage', [path])
}

function unstagePath(path) {
  emit('unstage', [path])
}

function stagePaths(paths) {
  const next = (Array.isArray(paths) ? paths : []).filter(Boolean)
  if (!next.length) return
  emit('stage', next)
}

function unstagePaths(paths) {
  const next = (Array.isArray(paths) ? paths : []).filter(Boolean)
  if (!next.length) return
  emit('unstage', next)
}

function openFile(path) {
  emit('open-file', { path })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b border-black/[0.04] px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs text-slate-500" :title="status?.rootPath || cwd">
          {{ status?.rootPath || cwd }}
        </div>
        <button
          class="rounded-lg border border-black/[0.06] px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:bg-black/[0.04]"
          type="button"
          @click="$emit('refresh')"
        >
          Refresh
        </button>
      </div>
      <div v-if="error" class="mt-2 text-xs text-red-600">{{ error }}</div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
      <div v-if="loading" class="text-sm text-slate-500">Loading git status…</div>
      <div v-else-if="status?.notRepo" class="text-sm text-slate-500">This workspace is not a git repository.</div>
      <div v-else-if="status" class="space-y-4">
        <div class="rounded-2xl border border-black/[0.06] bg-[#f7f7f4] px-3 py-3">
          <div class="flex items-center gap-2">
            <GitBranch class="h-4 w-4 text-slate-500" />
            <div class="text-sm font-medium text-slate-800">{{ status.branch || 'Detached HEAD' }}</div>
          </div>
          <div class="mt-1 text-xs text-slate-500">
            <span v-if="status.upstream">{{ status.upstream }}</span>
            <span v-if="status.ahead"> · ahead {{ status.ahead }}</span>
            <span v-if="status.behind"> · behind {{ status.behind }}</span>
          </div>

          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              :value="branchDraft"
              class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Create branch"
              @input="updateDraft"
              @keydown.enter.prevent="createBranch"
            />
            <button
              class="inline-flex items-center justify-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="branchWorking || !String(branchDraft ?? '').trim()"
              @click="createBranch"
            >
              <Loader2 v-if="branchWorking" class="h-4 w-4 animate-spin" />
              <Plus v-else class="h-4 w-4" />
              Create & switch
            </button>
          </div>

          <div v-if="branches.length" class="mt-3 flex gap-2 overflow-x-auto pb-1">
            <button
              v-for="branch in branches"
              :key="branch.name"
              class="shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors"
              :class="branch.current
                ? 'border-slate-300 bg-white text-slate-900'
                : 'border-black/[0.08] bg-white text-slate-600 hover:bg-black/[0.03]'"
              type="button"
              :disabled="branchWorking || branch.current"
              @click="switchBranch(branch.name)"
            >
              <span class="inline-flex items-center gap-1.5">
                <Check v-if="branch.current" class="h-3.5 w-3.5" />
                <span>{{ branch.name }}</span>
              </span>
            </button>
          </div>
        </div>

        <div v-if="!groups.staged.length && !groups.changes.length && !groups.untracked.length && !groups.conflicts.length" class="text-sm text-slate-500">
          Working tree clean.
        </div>

        <section v-if="groups.conflicts.length" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] uppercase tracking-wider text-slate-500">Conflicts</div>
            <div class="text-[11px] text-slate-400">{{ groups.conflicts.length }}</div>
          </div>
          <div class="space-y-2">
            <div
              v-for="entry in groups.conflicts"
              :key="`conflict:${entry.path}:${entry.statusCode}`"
              class="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
            >
              <button class="min-w-0 flex-1 text-left" type="button" @click="openFile(entry.path)">
                <div class="truncate text-sm font-medium text-slate-800">{{ entry.path }}</div>
                <div class="mt-0.5 truncate text-xs text-slate-500">{{ entry.statusText }}</div>
              </button>
            </div>
          </div>
        </section>

        <section v-if="groups.staged.length" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] uppercase tracking-wider text-slate-500">Staged changes</div>
            <div class="flex items-center gap-2">
              <div class="text-[11px] text-slate-400">{{ groups.staged.length }}</div>
              <button
                class="inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="actionWorking || !stagedPaths.length"
                @click="unstagePaths(stagedPaths)"
              >
                <Minus class="h-3.5 w-3.5" />
                Unstage all
              </button>
            </div>
          </div>
          <div class="space-y-2">
            <div
              v-for="entry in groups.staged"
              :key="`staged:${entry.path}:${entry.statusCode}`"
              class="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
            >
              <button class="min-w-0 flex-1 text-left" type="button" @click="openFile(entry.path)">
                <div class="truncate text-sm font-medium text-slate-800">{{ entry.path }}</div>
                <div class="mt-0.5 truncate text-xs text-slate-500">{{ entry.statusText }}</div>
              </button>
              <button
                class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="actionWorking"
                @click="unstagePath(entry.path)"
              >
                Unstage
              </button>
            </div>
          </div>
        </section>

        <section v-if="groups.changes.length" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] uppercase tracking-wider text-slate-500">Changes</div>
            <div class="flex items-center gap-2">
              <div class="text-[11px] text-slate-400">{{ groups.changes.length }}</div>
              <button
                class="inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="actionWorking || !changeStagePaths.length"
                @click="stagePaths(changeStagePaths)"
              >
                <Plus class="h-3.5 w-3.5" />
                Stage all
              </button>
            </div>
          </div>
          <div class="space-y-2">
            <div
              v-for="entry in groups.changes"
              :key="`change:${entry.path}:${entry.statusCode}`"
              class="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
            >
              <button class="min-w-0 flex-1 text-left" type="button" @click="openFile(entry.path)">
                <div class="truncate text-sm font-medium text-slate-800">{{ entry.path }}</div>
                <div class="mt-0.5 truncate text-xs text-slate-500">{{ entry.statusText }}</div>
              </button>
              <button
                class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="actionWorking"
                @click="stagePath(entry.path)"
              >
                Stage
              </button>
            </div>
          </div>
        </section>

        <section v-if="groups.untracked.length" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] uppercase tracking-wider text-slate-500">Untracked</div>
            <div class="text-[11px] text-slate-400">{{ groups.untracked.length }}</div>
          </div>
          <div class="space-y-2">
            <div
              v-for="entry in groups.untracked"
              :key="`untracked:${entry.path}`"
              class="flex items-center gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
            >
              <button class="min-w-0 flex-1 text-left" type="button" @click="openFile(entry.path)">
                <div class="truncate text-sm font-medium text-slate-800">{{ entry.path }}</div>
                <div class="mt-0.5 truncate text-xs text-slate-500">{{ entry.statusText }}</div>
              </button>
              <button
                class="rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="actionWorking"
                @click="stagePath(entry.path)"
              >
                Stage
              </button>
            </div>
          </div>
        </section>
      </div>
      <div v-else class="text-sm text-slate-500">Load git status for this workspace.</div>
    </div>
  </div>
</template>
