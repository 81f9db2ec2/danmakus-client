import { createApp } from 'vue';
import '../../assets/tailwind.css';
import App from './App.vue';

if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark');
}

createApp(App).mount('#app');
