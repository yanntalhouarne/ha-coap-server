/**
 * main.js - General JavaScript functionality for HA-CoAP Firmware Updater
 */

document.addEventListener('DOMContentLoaded', function() {
    // Initialize Bootstrap tooltips
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function(tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });
    
    // Set up socket connection for real-time updates
    setupGlobalSocket();
    
    // Add event listener for navigation confirmation when an update is in progress
    window.addEventListener('beforeunload', function(e) {
        // Check if an update is in progress
        if (typeof updateInProgress !== 'undefined' && updateInProgress) {
            // Cancel the event
            e.preventDefault();
            // Chrome requires returnValue to be set
            e.returnValue = 'Update in progress. Are you sure you want to leave?';
            // Return value for older browsers
            return 'Update in progress. Are you sure you want to leave?';
        }
    });
});

/**
 * Set up socket.io connection for real-time updates
 */
function setupGlobalSocket() {
    // Initialize socket if not already done
    if (typeof io !== 'undefined' && !window.globalSocket) {
        window.globalSocket = io();
        
        // Set up global event handlers
        window.globalSocket.on('connect', function() {
            console.log('Connected to server');
        });
        
        window.globalSocket.on('disconnect', function() {
            console.log('Disconnected from server');
        });
        
        // Listen for global notifications
        window.globalSocket.on('notification', function(data) {
            showNotification(data.type, data.message);
        });
    }
}

/**
 * Show a notification toast
 * @param {string} type - The notification type (success, warning, error)
 * @param {string} message - The notification message
 */
function showNotification(type, message) {
    // Create toast container if it doesn't exist
    let toastContainer = document.getElementById('toast-container');
    
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container position-fixed bottom-0 end-0 p-3';
        document.body.appendChild(toastContainer);
    }
    
    // Map type to Bootstrap color class
    const colorClass = {
        'success': 'text-bg-success',
        'warning': 'text-bg-warning',
        'error': 'text-bg-danger',
        'info': 'text-bg-info'
    }[type] || 'text-bg-secondary';
    
    // Create toast element
    const toastId = 'toast-' + Date.now();
    const toast = document.createElement('div');
    toast.id = toastId;
    toast.className = `toast ${colorClass}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.setAttribute('aria-atomic', 'true');
    
    // Create toast header
    const header = document.createElement('div');
    header.className = 'toast-header';
    
    const title = document.createElement('strong');
    title.className = 'me-auto';
    title.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    
    const timestamp = document.createElement('small');
    timestamp.textContent = 'just now';
    
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn-close';
    closeButton.setAttribute('data-bs-dismiss', 'toast');
    closeButton.setAttribute('aria-label', 'Close');
    
    header.appendChild(title);
    header.appendChild(timestamp);
    header.appendChild(closeButton);
    
    // Create toast body
    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = message;
    
    // Assemble toast
    toast.appendChild(header);
    toast.appendChild(body);
    
    // Add to container
    toastContainer.appendChild(toast);
    
    // Initialize and show toast
    const bsToast = new bootstrap.Toast(toast);
    bsToast.show();
    
    // Remove from DOM after hiding
    toast.addEventListener('hidden.bs.toast', function() {
        toast.remove();
    });
}

/**
 * Format a date for display
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString();
}

/**
 * Format a filesize for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted filesize
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Check if a file exists on the server
 * @param {string} path - File path to check
 * @returns {Promise<boolean>} Promise resolving to true if file exists
 */
function checkFileExists(path) {
    return fetch(`/api/check_file?path=${encodeURIComponent(path)}`)
        .then(response => response.json())
        .then(data => data.exists)
        .catch(error => {
            console.error('Error checking file:', error);
            return false;
        });
}

/**
 * Download a file from the server
 * @param {string} path - File path to download
 * @param {string} filename - Name to save as
 */
function downloadFile(path, filename) {
    const a = document.createElement('a');
    a.href = `/api/download?path=${encodeURIComponent(path)}`;
    a.download = filename || path.split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}