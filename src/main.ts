import { createApp } from 'vue';
import App from './App.vue';
import { checkForAppUpdates } from './updater';
import './styles.css';

createApp(App).mount('#app');
void checkForAppUpdates();
