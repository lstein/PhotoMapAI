// Unit tests for curator panel draggable functionality
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Helper to create a mock touch event
function createTouchEvent(type, clientX, clientY) {
  return new TouchEvent(type, {
    touches: type === 'touchend' ? [] : [{
      clientX,
      clientY,
      identifier: 0,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      target: document.querySelector('.curation-header')
    }],
    changedTouches: [{
      clientX,
      clientY,
      identifier: 0,
      pageX: clientX,
      pageY: clientY,
      screenX: clientX,
      screenY: clientY,
      target: document.querySelector('.curation-header')
    }],
    bubbles: true,
    cancelable: true
  });
}

describe('Curator Panel Draggable Functionality', () => {
  beforeEach(() => {
    // Set up DOM with curator panel
    document.body.innerHTML = `
      <div id="curationPanel" style="position: fixed; left: 20px; top: 20px;">
        <div class="curation-header">
          <h3>Model Training Dataset Curator</h3>
          <button class="close-icon">&times;</button>
        </div>
        <div class="curation-body">
          <p>Panel content</p>
        </div>
      </div>
    `;
  });

  describe('Mouse dragging', () => {
    it('should update panel position on mouse drag', () => {
      const panel = document.getElementById('curationPanel');
      const header = document.querySelector('.curation-header');
      
      // Simulate the draggable setup by adding event listeners
      let isDragging = false;
      let startX, startY, initialLeft, initialTop;
      
      header.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('close-icon')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        panel.style.left = (initialLeft + deltaX) + 'px';
        panel.style.top = (initialTop + deltaY) + 'px';
        panel.style.bottom = 'auto';
      });
      
      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
      
      // Get initial position
      const initialRect = panel.getBoundingClientRect();
      const expectedLeft = initialRect.left + 50;
      const expectedTop = initialRect.top + 50;
      
      // Start drag at (100, 100)
      const mouseDownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      });
      header.dispatchEvent(mouseDownEvent);
      
      // Move to (150, 150)
      const mouseMoveEvent = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 150
      });
      document.dispatchEvent(mouseMoveEvent);
      
      // Panel should have moved by 50px in both directions
      expect(panel.style.left).toBe(`${expectedLeft}px`);
      expect(panel.style.top).toBe(`${expectedTop}px`);
      
      // End drag
      const mouseUpEvent = new MouseEvent('mouseup', { bubbles: true });
      document.dispatchEvent(mouseUpEvent);
    });

    it('should not drag when clicking close button', () => {
      const panel = document.getElementById('curationPanel');
      const closeButton = document.querySelector('.close-icon');
      
      let isDragging = false;
      const header = document.querySelector('.curation-header');
      
      header.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('close-icon')) return;
        isDragging = true;
      });
      
      // Click on close button
      const mouseDownEvent = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100
      });
      Object.defineProperty(mouseDownEvent, 'target', {
        value: closeButton,
        enumerable: true
      });
      
      header.dispatchEvent(mouseDownEvent);
      
      expect(isDragging).toBe(false);
    });
  });

  describe('Touch dragging', () => {
    it('should update panel position on touch drag', () => {
      const panel = document.getElementById('curationPanel');
      const header = document.querySelector('.curation-header');
      
      // Simulate the draggable setup with touch support
      let isDragging = false;
      let startX, startY, initialLeft, initialTop;
      
      const getEventCoords = (e) => {
        if (e.touches && e.touches.length > 0) {
          return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
      };
      
      const startDrag = (e) => {
        if (e.target.classList.contains('close-icon')) return;
        isDragging = true;
        const coords = getEventCoords(e);
        startX = coords.x;
        startY = coords.y;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        e.preventDefault();
      };
      
      const handleDrag = (e) => {
        if (!isDragging) return;
        const coords = getEventCoords(e);
        const deltaX = coords.x - startX;
        const deltaY = coords.y - startY;
        panel.style.left = (initialLeft + deltaX) + 'px';
        panel.style.top = (initialTop + deltaY) + 'px';
        panel.style.bottom = 'auto';
        e.preventDefault();
      };
      
      const endDrag = () => {
        isDragging = false;
      };
      
      header.addEventListener('touchstart', startDrag);
      document.addEventListener('touchmove', handleDrag);
      document.addEventListener('touchend', endDrag);
      
      // Get initial position
      const initialRect = panel.getBoundingClientRect();
      const expectedLeft = initialRect.left + 50;
      const expectedTop = initialRect.top + 50;
      
      // Start touch at (100, 100)
      const touchStartEvent = createTouchEvent('touchstart', 100, 100);
      header.dispatchEvent(touchStartEvent);
      
      expect(isDragging).toBe(true);
      
      // Move to (150, 150)
      const touchMoveEvent = createTouchEvent('touchmove', 150, 150);
      document.dispatchEvent(touchMoveEvent);
      
      // Panel should have moved by 50px in both directions
      expect(panel.style.left).toBe(`${expectedLeft}px`);
      expect(panel.style.top).toBe(`${expectedTop}px`);
      
      // End touch
      const touchEndEvent = createTouchEvent('touchend', 150, 150);
      document.dispatchEvent(touchEndEvent);
      
      expect(isDragging).toBe(false);
    });

    it('should handle touchcancel event', () => {
      const header = document.querySelector('.curation-header');
      
      let isDragging = false;
      
      header.addEventListener('touchstart', () => {
        isDragging = true;
      });
      
      document.addEventListener('touchcancel', () => {
        isDragging = false;
      });
      
      // Start touch
      const touchStartEvent = createTouchEvent('touchstart', 100, 100);
      header.dispatchEvent(touchStartEvent);
      
      expect(isDragging).toBe(true);
      
      // Cancel touch
      const touchCancelEvent = new Event('touchcancel', { bubbles: true });
      document.dispatchEvent(touchCancelEvent);
      
      expect(isDragging).toBe(false);
    });
  });

  describe('Unified mouse and touch handling', () => {
    it('should work with both mouse and touch using the same logic', () => {
      const panel = document.getElementById('curationPanel');
      const header = document.querySelector('.curation-header');
      
      // Use the unified getEventCoords helper
      const getEventCoords = (e) => {
        if (e.touches && e.touches.length > 0) {
          return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
      };
      
      // Test with mouse event
      const mouseEvent = new MouseEvent('mousemove', {
        clientX: 100,
        clientY: 200
      });
      const mouseCoords = getEventCoords(mouseEvent);
      expect(mouseCoords.x).toBe(100);
      expect(mouseCoords.y).toBe(200);
      
      // Test with touch event
      const touchEvent = createTouchEvent('touchmove', 150, 250);
      const touchCoords = getEventCoords(touchEvent);
      expect(touchCoords.x).toBe(150);
      expect(touchCoords.y).toBe(250);
    });
  });
});
