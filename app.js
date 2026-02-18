/**
 * IntelliSchedule - Appointment Management UI
 * 
 * This is a prototype UI demonstrating the design and interactions.
 * All data is mocked. Backend implementation needed as described in README.md
 */

// Modal Management
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
        document.body.style.overflow = '';
    }
});

// Appointment Type Selection
document.querySelectorAll('.type-option').forEach(option => {
    option.addEventListener('click', function() {
        document.querySelectorAll('.type-option').forEach(opt => opt.classList.remove('active'));
        this.classList.add('active');
    });
});

// Form Submission Handler
document.querySelector('.modal-form').addEventListener('submit', function(e) {
    e.preventDefault();
    
    // Get form data
    const formData = new FormData(this);
    const data = Object.fromEntries(formData);
    
    // Get selected appointment type
    const selectedType = document.querySelector('.type-option.active');
    const appointmentType = selectedType ? selectedType.dataset.type : 'consultation';
    
    // In a real implementation, this would:
    // 1. Validate the data
    // 2. Send to backend API
    // 3. Update the UI with the new appointment
    // 4. Close the modal and show success notification
    
    console.log('Creating appointment:', { ...data, type: appointmentType });
    
    // Visual feedback
    const submitBtn = this.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Creating...';
    submitBtn.disabled = true;
    
    setTimeout(() => {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        closeModal('new-appointment');
        
        // Show success notification (would be a toast in full implementation)
        alert('Appointment created successfully! (Demo mode)');
    }, 800);
});

// Calendar Day Selection
document.querySelectorAll('.day-cell:not(.empty)').forEach(day => {
    day.addEventListener('click', function() {
        document.querySelectorAll('.day-cell.selected').forEach(d => d.classList.remove('selected'));
        this.classList.add('selected');
        
        // In real implementation: Load appointments for this date
        const date = this.textContent;
        console.log('Selected date:', date);
    });
});

// Navigation Items Active State
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', function(e) {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        this.classList.add('active');
        
        // In real implementation: Navigate to different views
        const section = this.querySelector('span').textContent;
        console.log('Navigating to:', section);
    });
});

// Appointment Card Interactions
document.querySelectorAll('.appointment-card').forEach(card => {
    card.addEventListener('click', function() {
        // In real implementation: Open appointment details/edit modal
        const title = this.querySelector('h3').textContent;
        console.log('Opening appointment:', title);
    });
});

// Type Item Interactions
document.querySelectorAll('.type-item').forEach(item => {
    item.addEventListener('click', function() {
        // In real implementation: Filter by this appointment type
        const typeName = this.querySelector('h4').textContent;
        console.log('Filter by type:', typeName);
    });
});

// Simulate AI Status Updates
function simulateAIUpdates() {
    const insights = [
        { icon: '💡', text: 'Your afternoon slots have 40% higher cancellation rate.', time: 'Just now' },
        { icon: '📈', text: 'Booking velocity up 23% compared to last month.', time: '5 min ago' },
        { icon: '🎯', text: 'Recommended: Block 30min buffer after strategy sessions.', time: '12 min ago' },
        { icon: '✨', text: 'AI optimized your Thursday schedule for better flow.', time: '30 min ago' }
    ];
    
    // In real implementation: This would come from WebSocket or polling API
    setInterval(() => {
        const randomInsight = insights[Math.floor(Math.random() * insights.length)];
        // Would update the AI insights panel in real app
    }, 30000);
}

// Search Functionality
const searchInput = document.querySelector('.header-search input');
if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener('input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const query = this.value;
            if (query.length > 2) {
                // In real implementation: Search appointments, clients, types
                console.log('Searching for:', query);
            }
        }, 300);
    });
}

// Notification System (Mock)
function showNotification(message, type = 'info') {
    // In real implementation: Show toast notification
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + K for search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.querySelector('.header-search input').focus();
    }
    
    // Cmd/Ctrl + N for new appointment
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        openModal('new-appointment');
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('🦀 IntelliSchedule UI Loaded');
    console.log('📋 This is a design prototype. See README.md for implementation details.');
    
    // Add selected state style dynamically
    const style = document.createElement('style');
    style.textContent = `
        .day-cell.selected {
            background: var(--primary);
            color: var(--text-inverse);
        }
    `;
    document.head.appendChild(style);
    
    simulateAIUpdates();
});

// Export functions for potential testing
window.IntelliSchedule = {
    openModal,
    closeModal,
    showNotification
};
