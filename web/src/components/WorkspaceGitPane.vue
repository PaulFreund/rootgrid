<script setup>
import { computed, ref, watch } from 'vue'
import { Check, ChevronDown, ChevronRight, FileText, GitBranch, Loader2, Minus, Plus } from 'lucide-vue-next'

import { buildWorkspaceGitSections, classifyWorkspaceGitEntries } from '../lib/workspaceGit.js'

const props = defineProps({
  mobile: {
    type: Boolean,
    default: false
  },
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
  },
  commitWorking: {
    type: Boolean,
    default: false
  },
  pushWorking: {
    type: Boolean,
    default: false
  },
  commitMessage: {
    type: String,
    default: ''
  }
})

const emit = defineEmits([
  'refresh',
  'open-file',
  'stage',
  'unstage',
  'commit',
  'push',
  'switch-branch',
  'create-branch',
  'update:branchDraft',
  'update:commit-message'
])

const sections = computed(() => buildWorkspaceGitSections(props.status))
const branches = computed(() => Array.isArray(props.status?.branches) ? props.status.branches : [])
const remotes = computed(() => Array.isArray(props.status?.remotes) ? props.status.remotes : [])
const visibleSections = computed(() => sections.value.filter((section) => Array.isArray(section.cards) && section.cards.length))
const summary = computed(() => classifyWorkspaceGitEntries(props.status?.entries))
const stagedCount = computed(() => summary.value.staged.length)
const changeCount = computed(() => summary.value.changes.length)
const untrackedCount = computed(() => summary.value.untracked.length)
const conflictCount = computed(() => summary.value.conflicts.length)
const totalCount = computed(() => stagedCount.value + changeCount.value + untrackedCount.value + conflictCount.value)
const mutationWorking = computed(() => props.actionWorking || props.branchWorking || props.commitWorking || props.pushWorking)
const hasTrackedUpstream = computed(() => Boolean(String(props.status?.upstream ?? '').trim()))
const inferredPushRemote = computed(() => {
  const upstream = String(props.status?.upstream ?? '').trim()
  if (upstream.includes('/')) return upstream.slice(0, upstream.indexOf('/'))
  if (upstream) return upstream
  if (remotes.value.includes('origin')) return 'origin'
  return remotes.value[0] ?? ''
})
const pushButtonLabel = computed(() => hasTrackedUpstream.value ? 'Push' : 'Publish')
const pushHelpText = computed(() => {
  if (hasTrackedUpstream.value) return props.status?.upstream ? `Push to ${props.status.upstream}` : 'Push current branch'
  if (inferredPushRemote.value) return `Publish branch to ${inferredPushRemote.value}`
  return 'Add a git remote to enable push'
})
const collapsedCardIds = ref(new Set())

watch(visibleSections, (nextSections) => {
  const valid = new Set(nextSections.flatMap((section) => section.cards.map((card) => card.id)))
  const next = new Set()
  for (const id of collapsedCardIds.value) {
    if (valid.has(id)) next.add(id)
  }
  collapsedCardIds.value = next
}, { immediate: true })

function updateDraft(event) {
  emit('update:branchDraft', event?.target?.value ?? '')
}

function updateCommitMessage(event) {
  emit('update:commit-message', event?.target?.value ?? '')
}

function createBranch() {
  emit('create-branch')
}

function commitChanges() {
  emit('commit')
}

function pushBranch() {
  emit('push')
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

function isCardExpanded(card) {
  return Boolean(card?.hasDiff) && !collapsedCardIds.value.has(card.id)
}

function toggleCard(card) {
  if (!card?.hasDiff) return
  const next = new Set(collapsedCardIds.value)
  if (next.has(card.id)) next.delete(card.id)
  else next.add(card.id)
  collapsedCardIds.value = next
}

function sectionBulkPaths(section) {
  return (Array.isArray(section?.cards) ? section.cards : [])
    .map((card) => String(card?.path ?? '').trim())
    .filter(Boolean)
}

function runSectionBulkAction(section) {
  const paths = sectionBulkPaths(section)
  if (!paths.length) return
  if (section?.bulkAction === 'unstage') unstagePaths(paths)
  else if (section?.bulkAction === 'stage') stagePaths(paths)
}

function runCardAction(section, card) {
  const path = String(card?.path ?? '').trim()
  if (!path) return
  if (section?.bulkAction === 'unstage') unstagePath(path)
  else if (section?.bulkAction === 'stage') stagePath(path)
}

function sectionBulkLabel(section) {
  return section?.bulkAction === 'unstage' ? 'Unstage all' : 'Stage all'
}

function cardActionLabel(section) {
  return section?.bulkAction === 'unstage' ? 'Unstage' : 'Stage'
}

function sectionTruncated(section) {
  return Boolean((Array.isArray(section?.cards) ? section.cards : []).some((card) => card?.diffTruncated && card?.hasDiff))
}

function lineRowClass(line) {
  if (line?.kind === 'add') return line?.changeKind === 'whitespace' ? 'bg-emerald-50/35' : 'bg-emerald-100/90'
  if (line?.kind === 'del') return line?.changeKind === 'whitespace' ? 'bg-rose-50/35' : 'bg-rose-100/90'
  if (line?.kind === 'meta') return 'bg-[#fbfbfa]'
  if (line?.kind === 'hunk') return 'bg-[#efefea]'
  return 'bg-[#fbfbfa]'
}

function lineContentClass(line) {
  if (line?.kind === 'add') return line?.changeKind === 'whitespace' ? 'text-emerald-800/75' : 'text-emerald-950'
  if (line?.kind === 'del') return line?.changeKind === 'whitespace' ? 'text-rose-800/75' : 'text-rose-950'
  if (line?.kind === 'hunk') return 'text-slate-600'
  return 'text-slate-800'
}

function commitShortcut(event) {
  if (!(event?.ctrlKey || event?.metaKey) || event?.key !== 'Enter') return
  event.preventDefault()
  commitChanges()
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="error" class="px-4 py-3 text-xs text-red-600">{{ error }}</div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
      <div v-if="loading" class="text-sm text-slate-500">Loading git status…</div>
      <div v-else-if="status?.notRepo" class="text-sm text-slate-500">This workspace is not a git repository.</div>
      <div v-else-if="status" class="space-y-4">
        <div class="rounded-xl border border-black/[0.06] bg-[#f8f8f5] px-3 py-2.5">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <GitBranch class="h-3.5 w-3.5 text-slate-500" />
                <div class="truncate text-[13px] font-medium text-slate-800">{{ status.branch || 'Detached HEAD' }}</div>
              </div>
              <div class="mt-0.5 text-[11px] text-slate-500">
                <span v-if="status.upstream">{{ status.upstream }}</span>
                <span v-else-if="inferredPushRemote">publish to {{ inferredPushRemote }}</span>
                <span v-else>no upstream</span>
                <span v-if="status.ahead"> · ahead {{ status.ahead }}</span>
                <span v-if="status.behind"> · behind {{ status.behind }}</span>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-1 text-[10px]">
              <span
                v-if="stagedCount"
                class="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700"
              >
                {{ stagedCount }} staged
              </span>
              <span
                v-if="changeCount || untrackedCount"
                class="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 font-medium text-amber-700"
              >
                {{ changeCount + untrackedCount }} changes
              </span>
              <span
                v-if="conflictCount"
                class="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 font-medium text-rose-700"
              >
                {{ conflictCount }} conflicts
              </span>
              <span
                v-if="totalCount"
                class="rounded-full border border-black/[0.08] bg-white px-2 py-0.5 text-slate-500"
              >
                {{ totalCount }} files
              </span>
            </div>
          </div>

          <div class="mt-2.5 flex flex-wrap items-center gap-2">
            <input
              :value="commitMessage"
              class="min-w-0 h-9 flex-1 rounded-lg border border-black/[0.08] bg-white px-3 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-300/30"
              placeholder="Commit message"
              :disabled="mutationWorking"
              @input="updateCommitMessage"
              @keydown="commitShortcut"
            />

            <button
              class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="mutationWorking || !stagedCount || !String(commitMessage ?? '').trim()"
              @click="commitChanges"
            >
              <Loader2 v-if="commitWorking" class="h-3.5 w-3.5 animate-spin" />
              <Check v-else class="h-3.5 w-3.5" />
              Commit
            </button>

            <button
              class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-black/[0.08] bg-white px-3 text-sm text-slate-800 transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="mutationWorking || !status.branch || (!hasTrackedUpstream && !inferredPushRemote)"
              @click="pushBranch"
            >
              <Loader2 v-if="pushWorking" class="h-3.5 w-3.5 animate-spin" />
              <GitBranch v-else class="h-3.5 w-3.5" />
              {{ pushButtonLabel }}
            </button>
          </div>

          <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
            <span>Ctrl/Cmd+Enter commits</span>
            <span class="hidden sm:inline text-slate-300">•</span>
            <span class="min-w-0 truncate">{{ pushHelpText }}</span>
          </div>

          <div class="mt-2.5 flex flex-col gap-2 sm:flex-row">
            <input
              :value="branchDraft"
              class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-300/30"
              placeholder="Create branch"
              :disabled="mutationWorking"
              @input="updateDraft"
              @keydown.enter.prevent="createBranch"
            />
            <button
              class="inline-flex items-center justify-center gap-1.5 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-800 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              :disabled="mutationWorking || !String(branchDraft ?? '').trim()"
              @click="createBranch"
            >
              <Loader2 v-if="branchWorking" class="h-3.5 w-3.5 animate-spin" />
              <Plus v-else class="h-3.5 w-3.5" />
              New branch
            </button>
          </div>

          <div v-if="branches.length" class="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
            <button
              v-for="branch in branches"
              :key="branch.name"
              class="shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors"
              :class="branch.current
                ? 'border-slate-300 bg-white text-slate-900'
                : 'border-black/[0.08] bg-white text-slate-600 hover:bg-black/[0.03]'"
              type="button"
              :disabled="mutationWorking || branch.current"
              @click="switchBranch(branch.name)"
            >
              <span class="inline-flex items-center gap-1.5">
                <Check v-if="branch.current" class="h-3.5 w-3.5" />
                <span>{{ branch.name }}</span>
              </span>
            </button>
          </div>
        </div>

        <div v-if="!visibleSections.length" class="text-sm text-slate-500">
          Working tree clean.
        </div>

        <section v-for="section in visibleSections" :key="section.key" class="space-y-2">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] uppercase tracking-wider text-slate-500">{{ section.label }}</div>
            <div class="flex items-center gap-2">
              <div class="text-[11px] text-slate-400">{{ section.cards.length }}</div>
              <button
                v-if="section.bulkAction"
                class="inline-flex items-center gap-1 rounded-md border border-black/[0.06] bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                :disabled="mutationWorking || !sectionBulkPaths(section).length"
                @click="runSectionBulkAction(section)"
              >
                <Minus v-if="section.bulkAction === 'unstage'" class="h-3.5 w-3.5" />
                <Plus v-else class="h-3.5 w-3.5" />
                {{ sectionBulkLabel(section) }}
              </button>
            </div>
          </div>

          <div v-if="sectionTruncated(section)" class="text-[11px] text-slate-400">
            Diff preview truncated for large output.
          </div>

          <div class="space-y-2">
            <div
              v-for="card in section.cards"
              :key="card.id"
              class="overflow-hidden rounded-[18px] border border-black/[0.06] bg-white"
            >
              <div class="flex items-center gap-1.5 px-2 py-1.5">
                <button
                  v-if="card.hasDiff"
                  class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-700"
                  type="button"
                  :title="isCardExpanded(card) ? 'Collapse diff' : 'Expand diff'"
                  @click="toggleCard(card)"
                >
                  <ChevronDown v-if="isCardExpanded(card)" class="h-3.5 w-3.5" />
                  <ChevronRight v-else class="h-3.5 w-3.5" />
                </button>
                <div v-else class="h-5 w-5 shrink-0" />

                <div class="min-w-0 flex flex-1 items-center gap-2">
                  <div class="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-slate-800" :title="card.displayPath">
                    {{ card.displayPath }}
                  </div>
                  <div
                    v-if="card.diffSummary.added || card.diffSummary.removed"
                    class="shrink-0 font-mono text-[11px] leading-5 tabular-nums"
                  >
                    <span class="text-emerald-700">+{{ card.diffSummary.added }}</span>
                    <span class="ml-1 text-rose-700">-{{ card.diffSummary.removed }}</span>
                  </div>
                </div>

                <button
                  class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-700"
                  type="button"
                  title="Open file"
                  @click="openFile(card.path)"
                >
                  <FileText class="h-3.5 w-3.5" />
                </button>

                <button
                  v-if="section.bulkAction"
                  class="shrink-0 rounded-full border border-black/[0.08] bg-white px-2 py-0.5 text-[11px] leading-5 text-slate-700 transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
                  type="button"
                  :disabled="mutationWorking"
                  @click="runCardAction(section, card)"
                >
                  {{ cardActionLabel(section) }}
                </button>
              </div>

              <div
                v-if="card.hasDiff && isCardExpanded(card)"
                class="border-t border-black/[0.05] bg-[#f7f7f4]"
              >
                <div class="rg-chat-local-x-scroll overflow-auto" :class="mobile ? 'max-h-[260px]' : 'max-h-[420px]'">
                  <table class="w-full border-collapse text-[11px] font-mono leading-5 sm:text-xs">
                    <tbody>
                      <tr
                        v-for="(line, idx) in (card.diffFile?.lines ?? [])"
                        :key="`${card.id}:${idx}`"
                        :class="lineRowClass(line)"
                      >
                        <td class="w-10 select-none whitespace-nowrap pr-2 pl-2 text-right align-top text-slate-400 sm:w-12">
                          {{ line.oldLine ?? '' }}
                        </td>
                        <td class="w-10 select-none whitespace-nowrap pr-2 text-right align-top text-slate-400 sm:w-12">
                          {{ line.newLine ?? '' }}
                        </td>
                        <td class="pr-3 align-top">
                          <pre
                            class="m-0 whitespace-pre"
                            :class="lineContentClass(line)"
                          >{{ line.text }}</pre>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
      <div v-else class="text-sm text-slate-500">Load git status for this workspace.</div>
    </div>
  </div>
</template>
