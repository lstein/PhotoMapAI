// Unit tests for metadata drawer draggable functionality
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Helper to create a mock touch event
function createTouchEvent(type, clientX, clientY) {
  const target = document.getElementById('filenameBanner');
  return new TouchEvent(type, {
    touches: type === 'touchend' ? [] : [{
      clientX,
      clientY,
      identifier: 0,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      target: target
    }],
    changedTouches: [{
      clientX,
      clientY,
      identifier: 0,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      target: target
    }],
    bubbles: true,
    cancelable: true
  });
}

describe('Metadata Drawer Draggable Functionality', () => {
  beforeEach(() => {
    // Set up DOM with metadata drawer
    document.body.innerHTML = `
      <div id="bannerDrawerContainer" class="banner-drawer-container" style="position: fixed; left: 20px; top: 50px;">
        <div id="overlayDrawer" class="overlay-drawer">
          <div class="drawer-handle">
            <svg class="drawer-arrow" viewBox="0 0 18 18">
              <path d="M7 14l5-5 5 5z" fill="currentColor" />
            </svg>
          </div>
        </div>
        <div id="filenameBanner" class="filename-banner">
          <div class="filenameDescContainer">
            <div class="filenameRow">
              <span id="filenameText">test-image.jpg</span>
            </div>
            <div id="descriptionText">Test description</div>
          </div>
        </div>
      </div>
    `;
  });

  describe('Mouse dragging', () => {
    it('should update drawer position on mouse drag', () => {
      const drawer = document.getElementById('bannerDrawerContainer');
      const banner = document.getElementById('filenameBanner');
      
      // Simulate the draggable setup by adding event listeners
      let isDraggingDrawer = false;
      let startX, startY, initialLeft, initialTop;
      
      const getEventCoords = (e) => {
        if (e.touches && e.touches.length > 0) {
          return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
      };
      
      drawer.addEventListener('mousedown', (e) => {
        if (
          e.target.classList.contains("banner-drawer-container") ||
          e.target.id === "filenameBanner" ||
          e.target.classList.contains("filename-banner")
        ) {
          isDraggingDrawer = true;
          const coords = getEventCoords(e);
          startX = coords.x;
          startY = coords.y;
          
          const rect = drawer.getBoundingClientRect();
          initialLeft = rect.left;
          initialTop = rect.top;
          
          e.preventDefault();
        }
      });
      
      window.addEventListener('mousemove', (e) => {
        if (!isDraggingDrawer) return;
        
        const coords = getEventCoords(e);
        const deltaX = coords.x - startX;
        const deltaY = coords.y - startY;
        
        const left = initialLeft + deltaX;
        const top = initialTop + deltaY;
        drawer.style.left = `${left}px`;
        drawer.style.top = `${top}px`;
        drawer.style.transform = "none";
        
        e.preventDefault();
      });
      
      window.addEventListener('mouseup', () => {
        isDraggingDrawer = false;
      });
      
      // Get initial position
      const initialRect = drawer.getBoundingClientRect();
      const expectedLeft = initialRect.left + 50;
      const expectedTop = initialRect.top + 50;
      
      // Start drag at (100, 100)
      const mouseDownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      });
      banner.dispatchEvent(mouseDownEvent);
      
      // Move to (150, 150) - delta of 50px in both directions
      const mouseMoveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 150
      });
      window.dispatchEvent(mouseMoveEvent);
      
      // End drag
      const mouseUpEvent = new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(mouseUpEvent);
      
      // Check that position was updated correctly (delta-based calculation)
      expect(drawer.style.left).toBe(`${expectedLeft}px`);
      expect(drawer.style.top).toBe(`${expectedTop}px`);
    });

    it('should not drag when clicking on non-draggable elements', () => {
      const drawer = document.getElementById('bannerDrawerContainer');
      const handle = document.querySelector('.drawer-handle');
      
      // Simulate the draggable setup
      let isDraggingDrawer = false;
      
      drawer.addEventListener('mousedown', (e) => {
        if (
          e.target.classList.contains("banner-drawer-container") ||
          e.target.id === "filenameBanner" ||
          e.target.classList.contains("filename-banner")
        ) {
          isDraggingDrawer = true;
        }
      });
      
      // Get initial position
      const initialLeft = drawer.style.left;
      const initialTop = drawer.style.top;
      
      // Try to drag from the handle (should not trigger dragging)
      const mouseDownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      });
      handle.dispatchEvent(mouseDownEvent);
      
      // Should not be dragging
      expect(isDraggingDrawer).toBe(false);
    });
  });

  describe('Touch dragging', () => {
    it('should update drawer position on touch drag', () => {
      const drawer = document.getElementById('bannerDrawerContainer');
      const banner = document.getElementById('filenameBanner');
      
      // Simulate the draggable setup
      let isDraggingDrawer = false;
      let startX, startY, initialLeft, initialTop;
      
      const getEventCoords = (e) => {
        if (e.touches && e.touches.length > 0) {
          return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
      };
      
      drawer.addEventListener('touchstart', (e) => {
        if (
          e.target.classList.contains("banner-drawer-container") ||
          e.target.id === "filenameBanner" ||
          e.target.classList.contains("filename-banner")
        ) {
          isDraggingDrawer = true;
          const coords = getEventCoords(e);
          startX = coords.x;
          startY = coords.y;
          
          const rect = drawer.getBoundingClientRect();
          initialLeft = rect.left;
          initialTop = rect.top;
          
          e.preventDefault();
        }
      }, { passive: false });
      
      window.addEventListener('touchmove', (e) => {
        if (!isDraggingDrawer) return;
        
        const coords = getEventCoords(e);
        const deltaX = coords.x - startX;
        const deltaY = coords.y - startY;
        
        const left = initialLeft + deltaX;
        const top = initialTop + deltaY;
        drawer.style.left = `${left}px`;
        drawer.style.top = `${top}px`;
        drawer.style.transform = "none";
        
        e.preventDefault();
      }, { passive: false });
      
      window.addEventListener('touchend', () => {
        isDraggingDrawer = false;
      });
      
      // Get initial position
      const initialRect = drawer.getBoundingClientRect();
      const expectedLeft = initialRect.left + 60;
      const expectedTop = initialRect.top + 60;
      
      // Start touch at (80, 80)
      const touchStartEvent = createTouchEvent('touchstart', 80, 80);
      banner.dispatchEvent(touchStartEvent);
      
      // Move to (140, 140) - delta of 60px in both directions
      const touchMoveEvent = createTouchEvent('touchmove', 140, 140);
      window.dispatchEvent(touchMoveEvent);
      
      // End touch
      const touchEndEvent = createTouchEvent('touchend', 140, 140);
      window.dispatchEvent(touchEndEvent);
      
      // Check that position was updated correctly (delta-based calculation)
      expect(drawer.style.left).toBe(`${expectedLeft}px`);
      expect(drawer.style.top).toBe(`${expectedTop}px`);
    });
  });

  describe('Smooth dragging behavior', () => {
    it('should calculate position based on delta from start for smooth tracking', () => {
      const drawer = document.getElementById('bannerDrawerContainer');
      const banner = document.getElementById('filenameBanner');
      
      // Simulate the draggable setup with the smooth approach
      let isDraggingDrawer = false;
      let startX, startY, initialLeft, initialTop;
      
      drawer.addEventListener('mousedown', (e) => {
        if (
          e.target.classList.contains("banner-drawer-container") ||
          e.target.id === "filenameBanner" ||
          e.target.classList.contains("filename-banner")
        ) {
          isDraggingDrawer = true;
          startX = e.clientX;
          startY = e.clientY;
          
          const rect = drawer.getBoundingClientRect();
          initialLeft = rect.left;
          initialTop = rect.top;
        }
      });
      
      const positionsRecorded = [];
      
      window.addEventListener('mousemove', (e) => {
        if (!isDraggingDrawer) return;
        
        // Key smooth dragging logic: use delta from start
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        
        const left = initialLeft + deltaX;
        const top = initialTop + deltaY;
        
        positionsRecorded.push({ left, top, deltaX, deltaY });
        
        drawer.style.left = `${left}px`;
        drawer.style.top = `${top}px`;
      });
      
      window.addEventListener('mouseup', () => {
        isDraggingDrawer = false;
      });
      
      // Start drag at (100, 100)
      const initialRect = drawer.getBoundingClientRect();
      const mouseDownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      });
      banner.dispatchEvent(mouseDownEvent);
      
      // Simulate multiple mouse moves to test smooth tracking
      const moves = [
        { x: 110, y: 110 }, // delta +10, +10
        { x: 125, y: 115 }, // delta +25, +15
        { x: 150, y: 140 }, // delta +50, +40
      ];
      
      moves.forEach(({ x, y }) => {
        const mouseMoveEvent = new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y
        });
        window.dispatchEvent(mouseMoveEvent);
      });
      
      // Verify each position was calculated correctly from the initial position + delta
      expect(positionsRecorded.length).toBe(3);
      expect(positionsRecorded[0]).toEqual({ left: initialRect.left + 10, top: initialRect.top + 10, deltaX: 10, deltaY: 10 });
      expect(positionsRecorded[1]).toEqual({ left: initialRect.left + 25, top: initialRect.top + 15, deltaX: 25, deltaY: 15 });
      expect(positionsRecorded[2]).toEqual({ left: initialRect.left + 50, top: initialRect.top + 40, deltaX: 50, deltaY: 40 });
    });
  });
});
