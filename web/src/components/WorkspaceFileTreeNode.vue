<script setup>
import { computed } from 'vue'
import { ChevronRight, FileText, FolderClosed } from 'lucide-vue-next'

defineOptions({
  name: 'WorkspaceFileTreeNode'
})

const props = defineProps({
  entry: {
    type: Object,
    required: true
  },
  depth: {
    type: Number,
    default: 0
  },
  selectedPath: {
    type: String,
    default: ''
  },
  expandedDirs: {
    type: Object,
    required: true
  },
  loadingDirs: {
    type: Object,
    required: true
  },
  directoryEntries: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['toggle-dir', 'open-file'])

const isDir = computed(() => props.entry?.kind === 'dir')
const isExpanded = computed(() => isDir.value && props.expandedDirs?.has?.(props.entry.path))
const isLoading = computed(() => isDir.value && props.loadingDirs?.has?.(props.entry.path))
const children = computed(() => props.directoryEntries?.get?.(props.entry.path) ?? [])
const isSelected = computed(() => String(props.selectedPath ?? '') === String(props.entry?.path ?? ''))

function onClick() {
  if (isDir.value) emit('toggle-dir', props.entry.path)
  else emit('open-file', props.entry.path)
}
</script>

<template>
  <div>
    <button
      class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.035]"
      :class="isSelected ? 'bg-black/[0.05]' : ''"
      :style="{ paddingLeft: `${8 + (depth * 14)}px` }"
      type="button"
      @click="onClick"
    >
      <ChevronRight
        v-if="isDir"
        class="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform"
        :class="isExpanded ? 'rotate-90' : ''"
      />
      <span v-else class="h-3.5 w-3.5 shrink-0" />
      <FolderClosed v-if="isDir" class="h-4 w-4 shrink-0 text-slate-400" />
      <FileText v-else class="h-4 w-4 shrink-0 text-slate-400" />
      <span class="min-w-0 flex-1 truncate text-slate-700">{{ entry.name }}</span>
    </button>

    <div v-if="isExpanded">
      <div v-if="isLoading" class="px-2 py-1 text-xs text-slate-400" :style="{ paddingLeft: `${34 + (depth * 14)}px` }">
        Loading…
      </div>
      <WorkspaceFileTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :expanded-dirs="expandedDirs"
        :loading-dirs="loadingDirs"
        :directory-entries="directoryEntries"
        @toggle-dir="$emit('toggle-dir', $event)"
        @open-file="$emit('open-file', $event)"
      />
    </div>
  </div>
</template>
