// album-management.js
import { loadAvailableAlbums } from './settings.js';
import { state, saveSettingsToLocalStorage } from './state.js';
import { removeSlidesAfterCurrent, resetAllSlides } from './swiper.js';
import { exitSearchMode } from './search.js';

export class AlbumManager {
  constructor() {
    this.overlay = document.getElementById('albumManagementOverlay');
    this.albumsList = document.getElementById('albumsList');
    this.template = document.getElementById('albumCardTemplate');
    this.progressPollers = new Map();
    this.addAlbumSection = document.getElementById('addAlbumSection');
    this.isSetupMode = false;
    
    this.initializeEventListeners();
    
    //  No albums found event
    window.addEventListener('noAlbumsFound', () => {
      this.enterSetupMode();
    });
  }

  initializeEventListeners() {
    // Main management button
    document.getElementById('manageAlbumsBtn').addEventListener('click', () => {
      this.show();
    });

    // Close button
    document.getElementById('closeAlbumManagementBtn').addEventListener('click', () => {
      this.hide();
    });

    // Show add album form button
    document.getElementById('showAddAlbumBtn').addEventListener('click', () => {
      this.showAddAlbumForm();
    });

    // Cancel add album buttons (both X and Cancel button)
    document.getElementById('cancelAddAlbumBtn').addEventListener('click', () => {
      this.hideAddAlbumForm();
    });
    
    document.getElementById('cancelAddAlbumBtn2').addEventListener('click', () => {
      this.hideAddAlbumForm();
    });

    // Add album button
    document.getElementById('addAlbumBtn').addEventListener('click', () => {
      this.addAlbum();
    });

    // Click outside to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
  }

  showAddAlbumForm() {
    this.addAlbumSection.style.display = 'block';
    this.addAlbumSection.classList.remove('slide-up');
    this.addAlbumSection.classList.add('slide-down');
    
    // Focus on the first input field
    document.getElementById('newAlbumKey').focus();
  }

  hideAddAlbumForm() {
    this.addAlbumSection.classList.remove('slide-down');
    this.addAlbumSection.classList.add('slide-up');
    
    // Hide the section after animation completes
    setTimeout(() => {
      this.addAlbumSection.style.display = 'none';
      this.clearAddAlbumForm();
    }, 300);
  }

  clearAddAlbumForm() {
    document.getElementById('newAlbumKey').value = '';
    document.getElementById('newAlbumName').value = '';
    document.getElementById('newAlbumDescription').value = '';
    document.getElementById('newAlbumPaths').value = '';
  }

  async show() {
    await this.loadAlbums();
    this.overlay.style.display = 'block';
    
    // Ensure add album form is hidden when opening normally
    if (!this.isSetupMode) {
      this.addAlbumSection.style.display = 'none';
      this.addAlbumSection.classList.remove('slide-down', 'slide-up');
    }
    
    // Check for ongoing indexing operations
    await this.checkForOngoingIndexing();
  }

  // Enter setup mode to add the first album
  async enterSetupMode() {
    console.log('Entering setup mode - no albums found');
    this.isSetupMode = true;
    
    // Show the manager
    await this.show();
    
    // Force show the add album form
    this.showAddAlbumForm();
    
    // Show setup message and hide normal content
    this.showSetupMessage();
    
    // Disable the close button and overlay click
    this.disableClosing();
  }

  showSetupMessage() {
    // Add a setup message at the top
    const existingMessage = this.overlay.querySelector('.setup-message'); 
    if (existingMessage) return; // Already shown
    
    const setupMessage = document.createElement('div');
    setupMessage.className = 'setup-message';
    setupMessage.style.cssText = `
      background: #ff9800;
      color: white;
      padding: 1em;
      border-radius: 8px;
      margin-bottom: 1em;
      text-align: center;
    `;
    setupMessage.innerHTML = `
      <h3 style="margin: 0 0 0.5em 0;">Welcome to SlideShow!</h3>
      <p style="margin: 0;">
        To get started, please add your first album below. 
        You'll need to specify the name and directory paths containing your images.
      </p>
    `;
    
    // Insert at the top of the albums list container
    const albumsContainer = this.overlay.querySelector('#albumManagementContent'); 
    if (albumsContainer) {
      albumsContainer.insertBefore(setupMessage, albumsContainer.firstChild);
    }
  }

  disableClosing() {
    // Hide the close button
    const closeBtn = this.overlay.querySelector('.close-albums-btn');
    if (closeBtn) {
      closeBtn.style.display = 'none';
    }
    
    // Disable overlay click to close
    this.overlay.onclick = null;
  }

  enableClosing() {
    // Show the close button
    const closeBtn = this.overlay.querySelector('.close-albums-btn');
    if (closeBtn) {
      closeBtn.style.display = 'block';
    }
    
    // Re-enable overlay click to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
  }

  // Prevent the manager window from being closed while in setup mode.
  hide() {
    if (this.isSetupMode) {
      console.log('Cannot close Album Manager - setup required');
      return; // Don't allow closing in setup mode
    }
    
    this.overlay.style.display = 'none';
    // Hide add album form when closing main modal
    this.hideAddAlbumForm();
    
    // Stop all progress polling
    this.progressPollers.forEach((interval, albumKey) => {
      clearInterval(interval);
    });
    this.progressPollers.clear();
  }

  async loadAlbums() {
    try {
      const response = await fetch('available_albums/');
      const albums = await response.json();
      
      this.albumsList.innerHTML = '';
      
      albums.forEach(album => {
        this.createAlbumCard(album);
      });
    } catch (error) {
      console.error('Failed to load albums:', error);
    }
  }

  createAlbumCard(album) {
    const card = this.template.content.cloneNode(true);
    
    // Populate album info
    card.querySelector('.album-name').textContent = album.name;
    card.querySelector('.album-key').textContent = `Key: ${album.key}`;
    card.querySelector('.album-description').textContent = album.description || 'No description';
    card.querySelector('.album-paths').textContent = `Paths: ${album.image_paths.join(', ')}`;
    
    // Set up event listeners
    const cardElement = card.querySelector('.album-card');
    cardElement.dataset.albumKey = album.key;
    
    // Edit button
    card.querySelector('.edit-album-btn').addEventListener('click', () => {
      this.editAlbum(cardElement, album);
    });
    
    // Delete button
    card.querySelector('.delete-album-btn').addEventListener('click', () => {
      this.deleteAlbum(album.key);
    });
    
    // Index button
    card.querySelector('.create-index-btn').addEventListener('click', () => {
      this.startIndexing(album.key, cardElement);
    });
    
    // Cancel index button
    card.querySelector('.cancel-index-btn').addEventListener('click', () => {
      this.cancelIndexing(album.key, cardElement);
    });
    
    this.albumsList.appendChild(card);
  }

  editAlbum(cardElement, album) {
    const editForm = cardElement.querySelector('.edit-form');
    const albumInfo = cardElement.querySelector('.album-info');
    
    // Populate edit form
    editForm.querySelector('.edit-album-name').value = album.name;
    editForm.querySelector('.edit-album-description').value = album.description || '';
    editForm.querySelector('.edit-album-paths').value = album.image_paths.join('\n');
    
    // Show edit form
    albumInfo.style.display = 'none';
    editForm.style.display = 'block';
    
    // Save button
    editForm.querySelector('.save-album-btn').onclick = () => {
      this.saveAlbumChanges(cardElement, album);
    };
    
    // Cancel button
    editForm.querySelector('.cancel-edit-btn').onclick = () => {
      albumInfo.style.display = 'block';
      editForm.style.display = 'none';
    };
  }

  async saveAlbumChanges(cardElement, album) {
    const editForm = cardElement.querySelector('.edit-form');
    
    const updatedAlbum = {
      key: album.key,
      name: editForm.querySelector('.edit-album-name').value,
      description: editForm.querySelector('.edit-album-description').value,
      image_paths: editForm.querySelector('.edit-album-paths').value
        .split('\n')
        .map(path => path.trim())
        .filter(path => path.length > 0),
      index: album.embeddings_file
    };
    
    try {
      const response = await fetch('update_album/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedAlbum)
      });
      
      if (response.ok) {
        // Refresh the albums list
        await this.loadAlbums();
        
        // refresh the settings dropdown
        await loadAvailableAlbums();
      } else {
        alert('Failed to update album');
      }
    } catch (error) {
      console.error('Failed to update album:', error);
      alert('Failed to update album');
    }
  }

  async addAlbum() {
    const key = document.getElementById('newAlbumKey').value.trim();
    const name = document.getElementById('newAlbumName').value.trim();
    const description = document.getElementById('newAlbumDescription').value.trim();
    const pathsText = document.getElementById('newAlbumPaths').value.trim();
    
    if (!key || !name || !pathsText) {
      alert('Please fill in all required fields');
      return;
    }
    
    const paths = pathsText.split('\n').map(path => path.trim()).filter(path => path.length > 0);
    
    const newAlbum = {
      key,
      name,
      description,
      image_paths: paths,
      index: `${paths[0]}/embeddings.npz`
    };
    
    try {
      const response = await fetch('add_album/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAlbum)
      });
      
      if (response.ok) {
        // Hide the add album form and refresh albums list
        this.hideAddAlbumForm();
        await this.loadAlbums();
        
        // Check if we are in setup mode and wait until albums are loaded
        if (this.isSetupMode) {
          await this.completeSetupMode();
        }
        
        // Start indexing the new album
        const newAlbumCard = Array.from(this.albumsList.querySelectorAll('.album-card'))
          .find(card => card.dataset.albumKey === key);
        
        if (newAlbumCard) {
          // Show a message that indexing is starting automatically
          const status = newAlbumCard.querySelector('.index-status');
          status.textContent = 'Auto-starting indexing for new album...';
          status.className = 'index-status indexing';
          
          // Start indexing after a short delay to let the UI update
          setTimeout(() => {
            this.startIndexing(key, newAlbumCard);
          }, 500);
        }
      } else {
        alert('Failed to add album');
      }
    } catch (error) {
      console.error('Failed to add album:', error);
      alert('Failed to add album');
    }
  }

  // Complete setup mode
  async completeSetupMode() {
    // Remove setup message
    const setupMessage = this.overlay.querySelector('.setup-message');
    if (setupMessage) {
      setupMessage.remove();
    }
    
    // Set newly created album as the current one
    try {
      const response = await fetch('available_albums/');
      const albums = await response.json();
      
      if (albums.length > 0) {
        const newAlbum = albums[0]; // First (and likely only) album

        // Update state and local storage
        state.album = newAlbum.key;
        state.embeddingsFile = newAlbum.embeddings_file;
        saveSettingsToLocalStorage();

        // Update settings dropdown
        await loadAvailableAlbums();

        // Update page title
        const titleElement = document.getElementById('slideshow_title');
        if (titleElement) {
          titleElement.textContent = `Slideshow - ${newAlbum.name}`;
        }

        // Initialize the slideshow with the new album
        resetAllSlides();
      }
    } catch (error) {
      console.error('Failed to set up new album:', error);
    }
    
    // Show completion message
    const completionMessage = document.createElement('div');
    completionMessage.style.cssText = `
      background: #4caf50;
      color: white;
      padding: 1em;
      border-radius: 8px;
      margin-bottom: 1em;
      text-align: center;
    `;
    completionMessage.innerHTML = `
      <h4 style="margin: 0 0 0.5em 0;">✅ Setup Complete!</h4>
      <p style="margin: 0;">
        Your album "${state.album}" is being indexed and is now active. 
        Once indexing completes, you can close this manager and start using the slideshow.
      </p>
    `;
    
    const albumsContainer = this.overlay.querySelector('#albumManagementContent');
    if (albumsContainer) {
      albumsContainer.insertBefore(completionMessage, albumsContainer.firstChild);
    }
    
    // Re-enable closing after 5 seconds
    setTimeout(() => {
      this.isSetupMode = false;
      this.enableClosing();
      completionMessage.remove();
    }, 5000);
  }

  async deleteAlbum(albumKey) {
    if (!confirm(`Are you sure you want to delete album "${albumKey}"? This action cannot be undone.`)) {
      return;
    }
    
    try {
      const response = await fetch(`delete_album/${albumKey}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        // Check if we're deleting the currently active album
        const isCurrentAlbum = state.album === albumKey;
        
        await this.loadAlbums();
        await loadAvailableAlbums();
        
        // If we deleted the current album, switch to the first available album
        if (isCurrentAlbum) {
          await this.handleDeletedCurrentAlbum();
        }
      } else {
        alert('Failed to delete album');
      }
    } catch (error) {
      console.error('Failed to delete album:', error);
      alert('Failed to delete album');
    }
  }

  async handleDeletedCurrentAlbum() {
    try {
      // Get the updated list of available albums
      const response = await fetch('available_albums/');
      const albums = await response.json();
      
      if (albums.length > 0) {
        // Switch to the first available album
        const firstAlbum = albums[0];
        
        console.log(`Switching from deleted album to: ${firstAlbum.key}`);
        
        // Update state and localStorage
        state.album = firstAlbum.key;
        state.embeddingsFile = firstAlbum.embeddings_file;
        saveSettingsToLocalStorage();
        
        // Update the settings dropdown
        const albumSelect = document.getElementById('albumSelect');
        if (albumSelect) {
          albumSelect.value = firstAlbum.key;
        }
        
        // Update page title
        const titleElement = document.getElementById('slideshow_title');
        if (titleElement) {
          titleElement.textContent = `Slideshow - ${firstAlbum.name}`;
        }
        
        // Clear and reset slideshow
        exitSearchMode();
        removeSlidesAfterCurrent();
        resetAllSlides();
        
        // Show notification
        this.showAlbumSwitchNotification(firstAlbum.name);
        
      } else {
        console.warn('No albums available after deletion');
        alert('No albums available. Please add a new album.');
      }
    } catch (error) {
      console.error('Failed to handle deleted current album:', error);
    }
  }

  async startIndexing(albumKey, cardElement) {
    try {
      const response = await fetch('update_index_async/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `album_key=${encodeURIComponent(albumKey)}`
      });
      
      if (response.ok) {
        this.showProgressUI(cardElement);
        this.startProgressPolling(albumKey, cardElement);
      } else {
        alert('Failed to start indexing');
      }
    } catch (error) {
      console.error('Failed to start indexing:', error);
      alert('Failed to start indexing');
    }
  }

  showProgressUI(cardElement) {
    this.showProgressUIWithoutScroll(cardElement);
    
    // Add the scroll behavior for new operations
    setTimeout(() => {
      const indexingSection = cardElement.querySelector('.indexing-section');
      indexingSection.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center',
        inline: 'nearest'
      });
    }, 100);
  }

  // Show progress UI without scrolling
  // This is used when restoring progress UI without scrolling the page
  showProgressUIWithoutScroll(cardElement) {
    const progressContainer = cardElement.querySelector('.progress-container');
    const createBtn = cardElement.querySelector('.create-index-btn');
    const cancelBtn = cardElement.querySelector('.cancel-index-btn');
    const status = cardElement.querySelector('.index-status');
    
    progressContainer.style.display = 'block';
    createBtn.style.display = 'none';
    cancelBtn.style.display = 'inline-block';
    status.className = 'index-status indexing';
    status.textContent = 'Indexing in progress...';
  }

  hideProgressUI(cardElement) {
    const progressContainer = cardElement.querySelector('.progress-container');
    const createBtn = cardElement.querySelector('.create-index-btn');
    const cancelBtn = cardElement.querySelector('.cancel-index-btn');
    
    progressContainer.style.display = 'none';
    createBtn.style.display = 'inline-block';
    cancelBtn.style.display = 'none';
  }

  async checkForOngoingIndexing() {
    // Get all album cards and check their indexing status
    const albumCards = this.albumsList.querySelectorAll('.album-card');
    
    // Check all albums in parallel for better performance
    const checkPromises = Array.from(albumCards).map(async (cardElement) => {
      const albumKey = cardElement.dataset.albumKey;
      
      try {
        const response = await fetch(`index_progress/${albumKey}`);
        
        if (response.ok) {
          const progress = await response.json();
          
          // If the operation is still running, restore the progress UI
          if (progress.status === 'indexing' || progress.status === 'scanning') {
            console.log(`Restoring progress UI for ongoing indexing: ${albumKey}`);
            
            // Restore the progress UI (but don't scroll since user is just reopening)
            this.showProgressUIWithoutScroll(cardElement);
            
            // Start polling for this album
            this.startProgressPolling(albumKey, cardElement);
            
            // Update with current progress immediately
            this.updateProgress(cardElement, progress);
            
            return { albumKey, restored: true };
          }
        }
      } catch (error) {
        // 404 or other errors are expected for albums not currently being indexed
        console.debug(`No ongoing operation for album: ${albumKey}`);
      }
      
      return { albumKey, restored: false };
    });
    
    // Wait for all checks to complete
    const results = await Promise.all(checkPromises);
    
    // Log summary
    const restoredCount = results.filter(r => r.restored).length;
    if (restoredCount > 0) {
      console.log(`Restored progress UI for ${restoredCount} ongoing indexing operation(s)`);
    }
  }

  updateProgress(cardElement, progress) {
    const progressBar = cardElement.querySelector('.progress-bar');
    const progressText = cardElement.querySelector('.progress-text');
    const status = cardElement.querySelector('.index-status');
    const estimatedTime = cardElement.querySelector('.estimated-time');
    
    progressBar.style.width = `${progress.progress_percentage}%`;
    progressText.textContent = `${Math.round(progress.progress_percentage)}%`;
    
    // update estimated time remaining
    if (progress.estimated_time_remaining !== null && progress.estimated_time_remaining !== undefined) {
      const timeRemaining = this.formatTimeRemaining(progress.estimated_time_remaining);
      estimatedTime.textContent = `Estimated time remaining: ${timeRemaining}`;
    } else {
      estimatedTime.textContent = ''; // Clear if no estimate available
    }
    
    if (progress.status === 'completed') {
      status.className = 'index-status completed';
      status.textContent = 'Indexing completed successfully';
      progressText.textContent = '100%';
      estimatedTime.textContent = ''; // Clear estimate when done
      
      // refresh the dropdown since indexing is complete
      loadAvailableAlbums().then(() => {
        console.log('Albums dropdown refreshed after successful indexing');
      }).catch(error => {
        console.error('Failed to refresh albums dropdown:', error);
      });
      
    } else if (progress.status === 'error') {
      status.className = 'index-status error';
      status.textContent = `Error: ${progress.error_message}`;
      estimatedTime.textContent = ''; // Clear estimate on error
    } else {
      status.textContent = `${progress.current_step} (${progress.images_processed}/${progress.total_images})`;
    }
  }

  // Start polling for indexing progress
  startProgressPolling(albumKey, cardElement) {
    // If already polling this album, don't start another interval
    if (this.progressPollers.has(albumKey)) {
      console.log(`Already polling progress for album: ${albumKey}`);
      return;
    }
    
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`index_progress/${albumKey}`);
        const progress = await response.json();
        
        this.updateProgress(cardElement, progress);
        
        if (progress.status === 'completed' || progress.status === 'error') {
          clearInterval(interval);
          this.progressPollers.delete(albumKey);
          
          if (progress.status === 'completed') {
            await loadAvailableAlbums();
            
            if (albumKey === state.album) {
              console.log(`Refreshing slideshow for completed indexing of current album: ${albumKey}`);
              resetAllSlides();
            }
          }
          
          setTimeout(() => {
            this.hideProgressUI(cardElement);
          }, 3000); // Hide after 3 seconds
        }
      } catch (error) {
        console.error('Failed to get progress:', error);
        clearInterval(interval);
        this.progressPollers.delete(albumKey);
      }
    }, 1000); // Poll every second
    
    this.progressPollers.set(albumKey, interval);
  }

  async cancelIndexing(albumKey, cardElement) {
    try {
      const response = await fetch(`cancel_index/${albumKey}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        // Stop polling
        if (this.progressPollers.has(albumKey)) {
          clearInterval(this.progressPollers.get(albumKey));
          this.progressPollers.delete(albumKey);
        }
        
        this.hideProgressUI(cardElement);
        
        const status = cardElement.querySelector('.index-status');
        status.className = 'index-status';
        status.textContent = 'Operation cancelled';
      }
    } catch (error) {
      console.error('Failed to cancel indexing:', error);
    }
  }

  formatTimeRemaining(seconds) {
    if (seconds < 0 || !isFinite(seconds)) {
      return 'Calculating...';
    }
    
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  // Notify user that album was switched after a deletion
  // This is used when the current album was deleted and we switched to a new one
  showAlbumSwitchNotification(newAlbumName) {
    // Create temporary notification
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #ff9800;
      color: white;
      padding: 1em;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      z-index: 4000;
      max-width: 300px;
    `;
    
    notification.innerHTML = `
      <div>
        <strong>Album switched to "${newAlbumName}"</strong><br>
        <small>The previous album was deleted</small>
      </div>
    `;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new AlbumManager();
});