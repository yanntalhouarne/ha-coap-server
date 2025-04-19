/**
 * updates.js - JavaScript functionality for firmware update processes
 */

// Global state
let updateInProgress = false;
let currentUpdateStatus = {
    state: 'idle',
    current_device: null,
    total_devices: 0,
    completed_devices: 0,
    successful_updates: 0,
    failed_updates: 0,
    skipped_updates: 0,
    upload_progress: 0
};

// Initialize when document is ready
document.addEventListener('DOMContentLoaded', function() {
    // Set up status polling
    if (isUpdatePage()) {
        // Poll for status updates every 3 seconds
        pollUpdateStatus();
        setInterval(pollUpdateStatus, 3000);
    }
});

/**
 * Check if we're on the update page
 * @returns {boolean} True if on update page
 */
function isUpdatePage() {
    return window.location.pathname.includes('/update');
}

/**
 * Poll the server for the current update status
 */
function pollUpdateStatus() {
    fetch('/api/update_status')
        .then(response => response.json())
        .then(status => {
            currentUpdateStatus = status;
            
            // Update UI if we're on the update page
            if (isUpdatePage()) {
                updateStatusDisplay(status);
            }
            
            // Update global state
            updateInProgress = (status.state === 'updating');
        })
        .catch(error => {
            console.error('Error fetching update status:', error);
        });
}

/**
 * Process a firmware image hash
 * @param {string} hash - The hash string to process
 * @returns {string} Shortened hash with tooltip
 */
function processHash(hash) {
    if (!hash) return 'Unknown';
    
    // Shorten the hash for display
    const shortHash = hash.substring(0, 8) + '...';
    return `<span title="${hash}" data-bs-toggle="tooltip">${shortHash}</span>`;
}

/**
 * Updates the UI based on current update status
 * @param {Object} status - Current update status
 */
function updateStatusDisplay(status) {
    // Only update if we're on the update page
    if (!isUpdatePage()) return;
    
    // Check if update elements exist
    const progressBar = document.getElementById('overall-progress-bar');
    if (!progressBar) return;
    
    // Update overall progress
    if (status.total_devices > 0) {
        const percent = Math.round((status.completed_devices / status.total_devices) * 100);
        document.getElementById('overall-progress-bar').style.width = `${percent}%`;
        document.getElementById('overall-progress-text').textContent = 
            `${status.completed_devices}/${status.total_devices} devices (${percent}%)`;
    }
    
    // Update current device progress
    if (document.getElementById('current-device-progress-bar')) {
        document.getElementById('current-device-progress-bar').style.width = `${status.upload_progress}%`;
        document.getElementById('current-device-progress-text').textContent = `${Math.round(status.upload_progress)}%`;
    }
    
    // Update device name
    if (document.getElementById('current-device-name')) {
        document.getElementById('current-device-name').textContent = status.current_device || 'None';
    }
    
    // Update counters
    if (document.getElementById('successful-count')) {
        document.getElementById('successful-count').textContent = status.successful_updates;
    }
    
    if (document.getElementById('skipped-count')) {
        document.getElementById('skipped-count').textContent = status.skipped_updates;
    }
    
    if (document.getElementById('failed-count')) {
        document.getElementById('failed-count').textContent = status.failed_updates;
    }
    
    // Check if update is complete
    if (status.state === 'completed' && updateInProgress) {
        updateInProgress = false;
        
        // Show completion alert if progress container exists
        const container = document.getElementById('update-progress-container');
        if (container) {
            const successCount = parseInt(status.successful_updates);
            const failedCount = parseInt(status.failed_updates);
            const skippedCount = parseInt(status.skipped_updates);
            
            let alertClass = 'alert-success';
            let message = `Update completed successfully! ${successCount} device(s) updated.`;
            
            if (failedCount > 0) {
                alertClass = 'alert-warning';
                message = `Update completed with issues. ${successCount} device(s) updated, ${failedCount} failed.`;
            }
            
            if (skippedCount > 0) {
                message += ` ${skippedCount} device(s) skipped (already had the image).`;
            }
            
            // Check if alert already exists
            const existingAlert = container.querySelector('.alert');
            if (existingAlert) {
                existingAlert.className = `alert ${alertClass}`;
                existingAlert.innerHTML = `<i class="bi bi-info-circle"></i> ${message}`;
            } else {
                const alertEl = document.createElement('div');
                alertEl.className = `alert ${alertClass} mt-3`;
                alertEl.innerHTML = `<i class="bi bi-info-circle"></i> ${message}`;
                container.appendChild(alertEl);
            }
            
            // Re-enable the start button if it exists
            const startBtn = document.getElementById('start-update-btn');
            if (startBtn) {
                startBtn.disabled = false;
                startBtn.innerHTML = '<i class="bi bi-play-fill"></i> Start Update Process';
            }
        }
    }
}

/**
 * Add a log message to the live log
 * @param {string} message - Log message to add
 */
function addToLog(message) {
    const logEl = document.getElementById('live-log');
    if (!logEl) return;
    
    const timestamp = new Date().toLocaleTimeString();
    
    // Add the message with timestamp
    logEl.textContent += `[${timestamp}] ${message}\n`;
    
    // Auto scroll to bottom
    logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Start a firmware update process
 * @param {Array} devices - Array of selected devices
 * @param {string} buildDir - Path to build directory
 * @param {string} updateMode - Update mode (test/confirm)
 * @param {number} stallTimeout - Stall timeout in seconds
 * @returns {Promise} Promise resolving with update result
 */
function startFirmwareUpdate(devices, buildDir, updateMode, stallTimeout) {
    if (devices.length === 0) {
        return Promise.reject(new Error('No devices selected'));
    }
    
    // Set update in progress
    updateInProgress = true;
    
    // Make API request to start update
    return fetch('/api/start_update', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            devices,
            build_dir: buildDir,
            update_mode: updateMode,
            stall_timeout: stallTimeout
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (!data.success) {
            throw new Error(data.error || 'Unknown error');
        }
        return data;
    });
}