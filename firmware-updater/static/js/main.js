/**
 * main.js - Helpers shared by every page of the HA-CoAP Firmware Updater
 *
 * Pages set window.updateInProgress while an update runs, so leaving the page asks first.
 */

window.updateInProgress = false;

window.addEventListener('beforeunload', function(e) {
    if (window.updateInProgress) {
        e.preventDefault();
        e.returnValue = 'Update in progress. Are you sure you want to leave?';
        return e.returnValue;
    }
});

/**
 * Fetch JSON from the server's API
 * @param {string} url - API URL
 * @param {Object} [options] - fetch options; a 'json' member is sent as the request body
 * @returns {Promise<Object>} The parsed response
 */
function apiFetch(url, options = {}) {
    if (options.json !== undefined) {
        options = Object.assign({}, options, {
            method: options.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options.json)
        });
        delete options.json;
    }
    return fetch(url, options).then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        return response.json();
    });
}

/**
 * Show a notification toast
 * @param {string} type - The notification type (success, warning, error, info)
 * @param {string} message - The notification message
 */
function showNotification(type, message) {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        document.body.appendChild(toastContainer);
    }

    const colorClass = {
        'success': 'text-bg-success',
        'warning': 'text-bg-warning',
        'error': 'text-bg-danger',
        'info': 'text-bg-info'
    }[type] || 'text-bg-secondary';

    const toast = document.createElement('div');
    toast.className = `toast ${colorClass}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.setAttribute('aria-atomic', 'true');

    const body = document.createElement('div');
    body.className = 'toast-body d-flex';
    const text = document.createElement('div');
    text.className = 'me-auto';
    text.textContent = message;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn-close btn-close-white ms-2';
    closeButton.setAttribute('data-bs-dismiss', 'toast');
    closeButton.setAttribute('aria-label', 'Close');
    body.appendChild(text);
    body.appendChild(closeButton);
    toast.appendChild(body);
    toastContainer.appendChild(toast);

    new bootstrap.Toast(toast).show();
    toast.addEventListener('hidden.bs.toast', () => toast.remove());
}

/**
 * Format a date for display
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
function formatDate(dateString) {
    return dateString ? new Date(dateString).toLocaleString() : 'Never';
}

/**
 * Format a file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted file size
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * Check that a device address is an IPv6 address mcumgr can use (no brackets or zone)
 * @param {string} address - Address to check
 * @returns {boolean} True if valid
 */
function isValidIPv6(address) {
    return /^[0-9A-Fa-f:]+$/.test(address) && address.includes(':') && address.length >= 2;
}

/**
 * Devices kept in the browser between pages: [{name, address, selected}]
 */
function loadSavedDevices() {
    try {
        return JSON.parse(localStorage.getItem('savedDevices')) || [];
    } catch (e) {
        return [];
    }
}

function saveDevices(devices) {
    localStorage.setItem('savedDevices', JSON.stringify(devices));
}
