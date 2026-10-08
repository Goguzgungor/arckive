// The reader's day/night pick (components/ThemeToggle.tsx), kept in this
// browser's localStorage under this key.
export const THEME_KEY = 'arckive-theme';

// Runs in <head> before the first paint, so a reader who picked night never
// sees a flash of day; without a pick the stylesheet follows the system.
export const THEME_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
