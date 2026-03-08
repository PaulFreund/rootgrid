<script setup>
import MonacoFileViewer from './MonacoFileViewer.vue'
import WorkspaceFileTreeNode from './WorkspaceFileTreeNode.vue'

const props = defineProps({
  rootPath: {
    type: String,
    default: ''
  },
  rootEntries: {
    type: Array,
    default: () => []
  },
  directoryEntries: {
    type: Object,
    required: true
  },
  expandedDirs: {
    type: Object,
    required: true
  },
  loadingDirs: {
    type: Object,
    required: true
  },
  filesLoading: {
    type: Boolean,
    default: false
  },
  filesError: {
    type: String,
    default: ''
  },
  selectedFilePath: {
    type: String,
    default: ''
  },
  selectedFile: {
    type: Object,
    default: null
  },
  fileLoading: {
    type: Boolean,
    default: false
  },
  fileError: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['refresh', 'toggle-dir', 'open-file'])
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1 truncate text-xs text-slate-500" :title="rootPath">{{ rootPath || 'Workspace files' }}</div>
        <button
          class="rounded-lg border border-black/[0.06] px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:bg-black/[0.04]"
          type="button"
          @click="$emit('refresh')"
        >
          Refresh
        </button>
      </div>
      <div v-if="filesError" class="mt-2 text-xs text-red-600">{{ filesError }}</div>
      <div v-if="fileError" class="mt-2 text-xs text-red-600">{{ fileError }}</div>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] sm:grid-cols-[260px_minmax(0,1fr)]">
      <div class="min-h-0 overflow-auto px-2 pb-2">
        <div v-if="filesLoading && !rootEntries.length" class="px-2 py-3 text-sm text-slate-500">Loading files…</div>
        <div v-else-if="!rootEntries.length" class="px-2 py-3 text-sm text-slate-500">No files found.</div>
        <div v-else class="space-y-0.5">
          <WorkspaceFileTreeNode
            v-for="entry in rootEntries"
            :key="entry.path"
            :entry="entry"
            :depth="0"
            :selected-path="selectedFilePath"
            :expanded-dirs="expandedDirs"
            :loading-dirs="loadingDirs"
            :directory-entries="directoryEntries"
            @toggle-dir="$emit('toggle-dir', $event)"
            @open-file="$emit('open-file', $event)"
          />
        </div>
      </div>

      <div class="min-h-0 overflow-hidden bg-[#fbfbfa]">
        <div v-if="fileLoading" class="px-4 py-3 text-sm text-slate-500">Loading file…</div>
        <div v-else-if="selectedFile?.binary" class="px-4 py-3 text-sm text-slate-500">Binary file preview is not supported.</div>
        <div v-else-if="selectedFile?.text !== undefined && selectedFile?.text !== null" class="flex h-full min-h-0 flex-col">
          <div class="truncate px-4 py-2 text-xs text-slate-500" :title="selectedFile.path">{{ selectedFile.path }}</div>
          <div class="min-h-0 flex-1">
            <MonacoFileViewer :path="selectedFile.path" :value="selectedFile.text" />
          </div>
        </div>
        <div v-else class="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
          Select a file to preview it.
        </div>
      </div>
    </div>
  </div>
</template>
