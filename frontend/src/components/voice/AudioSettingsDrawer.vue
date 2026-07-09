<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { formatShortcut } from '../../features/voice/keyboard';
import type { ShortcutAction } from '../../features/voice/types';

const autoGainControl = defineModel<boolean>('autoGainControl', { required: true });
const deafenShortcut = defineModel<string>('deafenShortcut', { required: true });
const echoCancellation = defineModel<boolean>('echoCancellation', { required: true });
const inputGain = defineModel<number>('inputGain', { required: true });
const inputSensitivity = defineModel<number>('inputSensitivity', { required: true });
const muteShortcut = defineModel<string>('muteShortcut', { required: true });
const noiseSuppression = defineModel<boolean>('noiseSuppression', { required: true });
const outputVolume = defineModel<number>('outputVolume', { required: true });
const selectedInputId = defineModel<string>('selectedInputId', { required: true });
const selectedOutputId = defineModel<string>('selectedOutputId', { required: true });

defineProps<{
  capturingShortcut: ShortcutAction | null;
  deafened: boolean;
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
}>();

defineEmits<{
  applyAudioSettings: [];
  clearShortcut: [action: ShortcutAction];
  close: [];
  startShortcutCapture: [action: ShortcutAction];
  updateMicGain: [];
  updateRemoteAudioSettings: [];
}>();
</script>

<template>
  <aside class="settings-drawer" aria-label="Audio settings">
    <div class="drawer-header">
      <div>
        <p class="eyebrow">Device setup</p>
        <h2>Audio settings</h2>
      </div>
      <button type="button" class="icon-button close-button" data-tooltip="Close" title="Close settings" @click="$emit('close')">
        <X :size="18" />
      </button>
    </div>

    <div class="settings-sections">
      <section class="settings-section" aria-labelledby="device-settings-heading">
        <h3 id="device-settings-heading">Devices</h3>
        <div class="settings-list">
          <label class="setting-item">
            <span class="setting-label">Microphone</span>
            <select v-model="selectedInputId" @change="$emit('applyAudioSettings')">
              <option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label || 'Microphone' }}
              </option>
            </select>
          </label>

          <label class="setting-item">
            <span class="setting-label">Output</span>
            <select v-model="selectedOutputId" @change="$emit('applyAudioSettings')">
              <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">
                {{ device.label || 'Speaker' }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="level-settings-heading">
        <h3 id="level-settings-heading">Levels</h3>
        <div class="settings-list">
          <label class="setting-item">
            <span class="setting-label">Mic gain</span>
            <input v-model.number="inputGain" type="range" min="0" max="100" @input="$emit('updateMicGain')" />
            <small>{{ inputGain }}%</small>
          </label>

          <label class="setting-item">
            <span class="setting-label">Input sensitivity</span>
            <input v-model.number="inputSensitivity" type="range" min="0" max="10" step="0.5" />
            <small>{{ inputSensitivity > 0 ? `${inputSensitivity}%` : 'Off' }}</small>
          </label>

          <label class="setting-item">
            <span class="setting-label">Output volume</span>
            <input v-model.number="outputVolume" type="range" min="0" max="100" @input="$emit('updateRemoteAudioSettings')" />
            <small>{{ deafened ? 'Muted' : `${outputVolume}%` }}</small>
          </label>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="shortcut-settings-heading">
        <h3 id="shortcut-settings-heading">Shortcuts</h3>
        <div class="settings-list">
          <div class="setting-item shortcut-row">
            <span class="setting-label">Mute shortcut</span>
            <div class="shortcut-control">
              <button type="button" class="shortcut-button" @click="$emit('startShortcutCapture', 'mute')">
                {{ capturingShortcut === 'mute' ? 'Press keys...' : muteShortcut ? formatShortcut(muteShortcut) : 'Not set' }}
              </button>
              <button
                v-if="muteShortcut"
                type="button"
                class="icon-button compact-button shortcut-clear"
                data-tooltip="Clear shortcut"
                title="Clear shortcut"
                @click="$emit('clearShortcut', 'mute')"
              >
                <X :size="15" />
              </button>
            </div>
          </div>

          <div class="setting-item shortcut-row">
            <span class="setting-label">Deafen shortcut</span>
            <div class="shortcut-control">
              <button type="button" class="shortcut-button" @click="$emit('startShortcutCapture', 'deafen')">
                {{ capturingShortcut === 'deafen' ? 'Press keys...' : deafenShortcut ? formatShortcut(deafenShortcut) : 'Not set' }}
              </button>
              <button
                v-if="deafenShortcut"
                type="button"
                class="icon-button compact-button shortcut-clear"
                data-tooltip="Clear shortcut"
                title="Clear shortcut"
                @click="$emit('clearShortcut', 'deafen')"
              >
                <X :size="15" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="processing-settings-heading">
        <h3 id="processing-settings-heading">Processing</h3>
        <div class="settings-list settings-toggle-list">
          <label class="setting-item setting-toggle">
            <input v-model="noiseSuppression" type="checkbox" @change="$emit('applyAudioSettings')" />
            <span>Noise suppression</span>
          </label>
          <label class="setting-item setting-toggle">
            <input v-model="echoCancellation" type="checkbox" @change="$emit('applyAudioSettings')" />
            <span>Echo cancellation</span>
          </label>
          <label class="setting-item setting-toggle">
            <input v-model="autoGainControl" type="checkbox" @change="$emit('applyAudioSettings')" />
            <span>Auto gain</span>
          </label>
        </div>
      </section>
    </div>
  </aside>
</template>
