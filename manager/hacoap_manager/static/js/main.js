// HA-CoAP Fleet Manager: the page. Plain JavaScript modules, no build step: each module wires its
// own part of the page as it loads, and this one, loaded last, draws it the first time.
// Text from devices and from the user is only ever inserted as text (textContent), never as HTML.

import './core.js';
import { currentRoute, showTab } from './tabs.js';
import './devices.js';
import './updates.js';
import './images.js';
import './network.js';
import './builds.js';
import { renderNotificationState } from './dashboard.js';
import './charts.js';
import './graphs.js';
import './motion.js';
import './timeline.js';
import './device.js';
import './floorplan.js';
import './tree.js';
import './netframe.js';
import './console.js';
import './settings.js';
import { connectEvents, renderClock } from './live.js';
import { setTheme } from './themes.js';
import './pages.js';
import './palette.js';

setTheme(null);  // the theme chosen (System included), as theme.js applied it
renderClock();
setInterval(renderClock, 30000);
showTab(currentRoute());
connectEvents();
renderNotificationState();
window.hacoapStarted = true;  // index.html reports any error before this
