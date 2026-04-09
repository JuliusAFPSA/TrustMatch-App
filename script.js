const uploadArea = document.getElementById('uploadArea');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const form = document.getElementById('signInForm');
const continueBtn = document.getElementById('continueBtn');

if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // In a real app, do validation/auth against API here.
    window.location.href = 'past.html';
  });
}

if (continueBtn) {
  continueBtn.addEventListener('click', () => {
    window.location.href = 'resume.html';
  });
}

if (uploadBtn) {
  uploadBtn.addEventListener('click', () => fileInput.click());
}

if (uploadArea) {
  uploadArea.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover'].forEach((event) => {
    uploadArea.addEventListener(event, (e) => {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((event) => {
    uploadArea.addEventListener(event, (e) => {
      e.preventDefault();
      e.stopPropagation();
      uploadArea.classList.remove('dragover');
    });
  });

  uploadArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      fileInput.files = files;
      alert(files.length + ' file(s) added');
    }
  });
}
