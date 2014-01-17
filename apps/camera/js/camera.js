
define(function(require, exports, module) {
/*global CONFIG_MAX_IMAGE_PIXEL_SIZE*/

'use strict';

/**
 * Module Dependencies
 */

var getVideoMetaData = require('lib/getvideometadata');
var constants = require('config/camera');
var orientation = require('orientation');
var debug = require('debug')('camera');
var allDone = require('utils/alldone');
var bindAll = require('utils/bindAll');
var CameraUtils = require('utils/camera-utils');
var model = require('vendor/model');

/**
 * Locals
 */

var RECORD_SPACE_MIN = constants.RECORD_SPACE_MIN;
var RECORD_SPACE_PADDING = constants.RECORD_SPACE_PADDING;
var ESTIMATED_JPEG_FILE_SIZE = constants.ESTIMATED_JPEG_FILE_SIZE;
var MIN_RECORDING_TIME = constants.MIN_RECORDING_TIME;

/**
 * Locals
 */

// Our predetermined configuration
// for camera and video flash
var flashConfig = {
  camera: {
    defaultMode: 'auto',
    supports: ['off', 'auto', 'on']
  },
  video: {
    defaultMode: 'off',
    supports: ['off', 'torch']
  }
};

// Mixin model methods (also events)
var proto = model(Camera.prototype);

/**
 * Exports
 */

module.exports = Camera;

/**
 * Initialize a new 'Camera'
 *
 * Options:
 *
 *   - {Element} container
 *
 * @param {Object} options
 */
function Camera(options) {
  debug('initializing');
  options = options || {};
  this.container = options.container;
  this.mozCamera = null;
  bindAll(this);

  // Flash state
  this.flash = {

    // All flash hardware modes
    // on this current camera.
    all: [],

    // Flash modes currently
    // available with the current
    // combination of hardware
    // and capture mode.
    available: [],

    // The index of the current
    // flash in the avaiable list.
    current: null
  };

  this.set('number', 0);
  this.autoFocus = {};
  this.tmpVideo = {
    storage: navigator.getDeviceStorage('videos'),
    filename: null,
    filepath: null
  };

  debug('initialized', this.get('number'));
}

proto.loadStreamInto = function(el, done) {
  debug('loading stream into element');

  var mozCamera = this.mozCamera;
  var self = this;

  this.getStream(function(stream) {
    el.mozSrcObject = stream;
    debug('got stream');

    // Wait till we know the stream is flowing.
    mozCamera.onPreviewStateChange = function(state) {
      if (state === 'started') {
        mozCamera.onPreviewStateChange = null;
        self.emit('streamloaded');
        debug('stream loaded');
        done();
      }
    };
  });
};

proto.getStream = function(done) {
  var mozCamera = this.mozCamera;
  var mode = this.get('mode');
  debug('get %s stream', mode);

  switch (mode) {
    case 'camera':
      mozCamera.getPreviewStream(this.previewSize, done);
      break;
    case 'video':
      mozCamera.getPreviewStreamVideoMode(this.videoProfile, done);
      break;
  }
};

proto.load = function() {
  var mozCameras = navigator.mozCameras;
  var cameraList = mozCameras.getListOfCameras();
  var number = this.get('number');
  var self = this;

  // Store camera count
  this.set('numCameras', cameraList.length);

  // If there is already a camera,
  // we have to 'release' it first.
  if (this.mozCamera) { this.release(getCamera); }
  else { getCamera(); }

  function getCamera() {
    var config = { camera: cameraList[number] };
    mozCameras.getCamera(config, self.configureCamera);
  }

  debug('load camera: ', number);
};

proto.configureCamera = function(mozCamera) {
  debug('configure');

  var capabilities = mozCamera.capabilities;
  var done = allDone();
  var self = this;

  // Store the Gecko
  // mozCamera interface
  this.mozCamera = mozCamera;

  // Configure all the things
  this.configurePictureSize(mozCamera);
  this.configureFocus(capabilities.focusModes);
  this.configureFlash(capabilities.flashModes);
  this.configureVideoProfile(capabilities, done());

  // Bind to some hardware events
  mozCamera.onShutter = self.onShutter;
  mozCamera.onRecorderStateChange = self.onRecorderStateChange;

  done(function() {
    self.configurePreviewSize(capabilities.previewSizes);
    debug('configured');
    self.emit('configured');
  });
};


proto.configurePictureSize = function(mozCamera) {
  var capabilities = mozCamera.capabilities;
  var pictureSizes = capabilities.pictureSizes;
  var thumbnailSizes = capabilities.thumbnailSizes;

  // Store picked pictureSize
  this.pictureSize = this.pickPictureSize(pictureSizes);

  var width = this.pictureSize.width;
  var height = this.pictureSize.height;

  // Store picked maxPictureSize
  this.maxPictureSize = (width * height * 4) + 4096;

  var thumbnailSize = this.pickThumbnailSize(thumbnailSizes, this.pictureSize);

  if (thumbnailSize) {
    mozCamera.thumbnailSize = thumbnailSize;
  }

  debug('configured picture size %d x %d', width, height);
};

proto.configureFlash = function(allModes) {
  this.flash.all = allModes || [];

  var cameraMode = this.get('mode');
  var config = flashConfig[cameraMode];
  var supported = config.supports;
  var index;

  this.flash.available = this.flash.all.filter(function(mode) {
    return !!~supported.indexOf(mode);
  });

  // Decide on the initial mode
  index = this.flash.available.indexOf(config.defaultMode);
  if (!~index) { index = 0; }

  this.setFlashMode(index);
  debug('configured flash, initial: %d', index);
};

proto.configureFocus = function(modes) {
  var supports = this.autoFocus;
  (modes || []).forEach(function(mode) {
    supports[mode] = true;
  });
  debug('focus configured', supports);
};

proto.configureVideoProfile = function(capabilities, done) {
  var self = this;
  this.getMozSettingsSizes(function(mozSettingsSizes) {
    var recorderProfiles = capabilities.recorderProfiles;
    self.videoProfile = self.pickVideoProfile(
      recorderProfiles,
      mozSettingsSizes);
    self.videoProfile.rotation = orientation.get();
    debug('video profile configured', self.videoProfile);
    done();
  });
};

proto.configurePreviewSize = function(previewSizes) {
  var viewportSize = {
    width: document.body.clientHeight * window.devicePixelRatio,
    height: document.body.clientWidth * window.devicePixelRatio
  };
  var currentCameraMode = this.get('mode');
  var pickedPreviewSize;
  if (currentCameraMode === 'camera') {
    pickedPreviewSize = CameraUtils.selectOptimalPreviewSize(viewportSize,
                                                             previewSizes);
    // We should always have a valid preview size, but just in case
    // we don't, pick the first provided
    this.previewSize = pickedPreviewSize || previewSizes[0];
  }
};

/**
 * Sets the current flash mode,
 * both on the Camera instance
 * and on the cameraObj hardware.
 *
 * @param {Number} index
 */
proto.setFlashMode = function(index) {
  var name = this.flash.available[index];
  this.mozCamera.flashMode = name;
  this.flash.current = index;
  this.set('flash', name);
  debug('flash mode set: %d (%s)', index, name);
};

proto.getMozSettingsSizes = function(done) {
  done = done || function() {};
  var key = 'camera.recording.preferredSizes';
  var self = this;

  // Return the settings if they
  // have already been retrieved.
  // setTimeout used to ensure the
  // callback is always called async.
  if (this.getMozSettingsSizes) {
    setTimeout(function() { done(this.getMozSettingsSizes); });
    return;
  }

  var req = navigator.mozSettings
    .createLock()
    .get(key)
    .onsuccess = onSuccess;

  function onSuccess() {
    self.getMozSettingsSizes = req.result[key] || [];
    debug('got settings sizes', self.getMozSettingsSizes);
    done(self.getMozSettingsSizes);
  }
};

proto.pickVideoProfile = function(profiles, preferredSizes) {
  debug('pick video profile');

  var targetFileSize = this.get('targetFileSize');
  var matchedProfileName;
  var profileName;
  var profile;

  if (preferredSizes) {
    for (var i = 0; i < preferredSizes.length; i++) {
      if (preferredSizes[i] in profiles) {
        matchedProfileName = preferredSizes[i];
        break;
      }
    }
  }

  if (targetFileSize && 'qcif' in profiles) {
    profileName = 'qcif';
  } else if (matchedProfileName) {
    profileName = matchedProfileName;
  // Default to cif profile
  } else if ('cif' in profiles) {
    profileName = 'cif';
  // Fallback to first valid profile if none found
  } else {
    profileName = Object.keys(profiles)[0];
  }

  profile = {
    profile: profileName,
    rotation: 0,
    width: profiles[profileName].video.width,
    height: profiles[profileName].video.height
  };

  debug('video profile picked', profile);
  return profile;
};

/**
 * Releases the camera hardware.
 *
 * @param  {Function} done
 */
proto.release = function(done) {
  done = done || function() {};

  if (!this.mozCamera) {
    return;
  }

  var self = this;
  this.mozCamera.release(onSuccess, onError);

  function onSuccess() {
    debug('successfully released');
    self.mozCamera = null;
    done();
  }

  function onError() {
    debug('failed to release hardware');
    done();
  }
};

proto.pickPictureSize = function(pictureSizes) {
  var targetFileSize = this.get('targetFileSize') || 0;
  var targetWidth = this.get('targetWidth');
  var targetHeight = this.get('targetHeight');
  var targetSize = null;
  var pictureSize;

  // Account for any
  // enforced size restrictions
  if (targetWidth && targetHeight) {
    targetSize = {
      width: targetWidth,
      height: targetHeight
    };
  }

  // CONFIG_MAX_IMAGE_PIXEL_SIZE is
  // maximum image resolution for still
  // photos taken with camera.
  //
  // It's from config.js which is
  // generatedin build time, 5 megapixels
  // by default (see build/application-data.js).
  // It should be synced with Gallery app
  // and update carefully.
  var maxRes = CONFIG_MAX_IMAGE_PIXEL_SIZE;
  var size = pictureSizes.reduce(function(acc, size) {
    var mp = size.width * size.height;

    // we don't need the
    // resolution larger
    // than maxRes
    if (mp > maxRes) {
      return acc;
    }

    // We assume the relationship
    // between MP to file size is
    // linear. This may be
    // inaccurate on all cases.
    var estimatedFileSize = mp * ESTIMATED_JPEG_FILE_SIZE / maxRes;
    if (targetFileSize > 0 && estimatedFileSize > targetFileSize) {
      return acc;
    }

    if (targetSize) {

      // find a resolution both width
      // and height are large than pick size
      if (size.width < targetSize.width || size.height < targetSize.height) {
        return acc;
      }

      // it's first pictureSize.
      if (!acc.width || acc.height) {
        return size;
      }

      // find large enough but
      // as small as possible.
      return (mp < acc.width * acc.height) ? size : acc;
    } else {

      // no target size, find
      // as large as possible.
      return (mp > acc.width * acc.height && mp <= maxRes) ? size : acc;
    }
  }, {width: 0, height: 0});

  pictureSize = (size.width === 0 && size.height === 0) ?
    pictureSizes[0] : size;

  debug('picture size picked', pictureSize);
  return pictureSize;
};

proto.pickThumbnailSize = function(thumbnailSizes, pictureSize) {
  var screenWidth = window.innerWidth * window.devicePixelRatio;
  var screenHeight = window.innerHeight * window.devicePixelRatio;
  var pictureAspectRatio = pictureSize.width / pictureSize.height;
  var currentThumbnailSize;
  var i;

  // Coping the array to not modify the original
  thumbnailSizes = thumbnailSizes.slice(0);
  if (!thumbnailSizes || !pictureSize) {
    return;
  }

  function imageSizeFillsScreen(pixelsWidth, pixelsHeight) {
    return ((pixelsWidth >= screenWidth || // portrait
             pixelsHeight >= screenHeight) &&
            (pixelsWidth >= screenHeight || // landscape
             pixelsHeight >= screenWidth));
  }

  // Removes the sizes with the wrong aspect ratio
  thumbnailSizes = thumbnailSizes.filter(function(thumbnailSize) {
    var thumbnailAspectRatio = thumbnailSize.width / thumbnailSize.height;
    return Math.abs(thumbnailAspectRatio - pictureAspectRatio) < 0.05;
  });

  if (thumbnailSizes.length === 0) {
    console.error('Error while selecting thumbnail size. ' +
      'There are no thumbnail sizes that match the ratio of ' +
      'the selected picture size: ' + JSON.stringify(pictureSize));
    return;
  }

  // Sorting the array from smaller to larger sizes
  thumbnailSizes.sort(function(a, b) {
    return a.width * a.height - b.width * b.height;
  });

  for (i = 0; i < thumbnailSizes.length; ++i) {
    currentThumbnailSize = thumbnailSizes[i];
    if (imageSizeFillsScreen(currentThumbnailSize.width,
                             currentThumbnailSize.height)) {
      return currentThumbnailSize;
    }
  }

  return thumbnailSizes[thumbnailSizes.length - 1];
};

/**
 * Takes a photo, or begins/ends
 * a video capture session.
 *
 * Options:
 *
 *   - `position` {Object} - geolocation to store in EXIF
 *
 * @param  {Object} options
 *  public
 */
proto.capture = function(options) {
  switch (this.get('mode')) {
    case 'camera': this.takePicture(options); break;
    case 'video': this.toggleRecording(options); break;
  }
};

proto.takePicture = function(options) {
  var self = this;
  this.prepareTakePicture(onReady);

  function onReady() {
    var position = options && options.position;
    var config = {
      orientation: orientation.get(),
      dateTime: Date.now() / 1000,
      fileFormat: 'jpeg'
    };

    // If position has been
    // passed in, add it to
    // the config object.
    if (position) {
      config.position = position;
    }

    self.mozCamera.pictureSize = self.pictureSize;
    self.mozCamera.takePicture(config, onSuccess, onError);
  }

  function onSuccess(blob) {
    self.resumePreview();
    self.set('focus', 'none');
    self.emit('newimage', { blob: blob });
  }

  function onError() {
    var title = navigator.mozL10n.get('error-saving-title');
    var text = navigator.mozL10n.get('error-saving-text');
    alert(title + '. ' + text);
  }
};

proto.prepareTakePicture = function(done) {
  var self = this;

  if (!this.autoFocus.auto) {
    done();
    return;
  }

  this.emit('preparingtotakepicture');
  this.mozCamera.autoFocus(onFocus);
  this.set('focus', 'focusing');

  function onFocus(success) {
    if (success) {
      self.set('focus', 'focused');
      done();
      return;
    }

    // On failure
    self.set('focus', 'fail');
    setTimeout(reset, 1000);
    done();
  }

  function reset() {
    self.set('focus', 'none');
  }
};

proto.toggleRecording = function(o) {
  var recording = this.get('recording');
  if (recording) { this.stopRecording(o); }
  else { this.startRecording(o); }
};

proto.startRecording = function(options) {
  var storage = this.tmpVideo.storage;
  var mozCamera = this.mozCamera;
  var self = this;

  // First check if there is enough free space
  this.getTmpStorageSpace(gotStorageSpace);

  function gotStorageSpace(err, freeBytes) {
    if (err) { return self.onRecordingError(); }

    var notEnoughSpace = freeBytes < RECORD_SPACE_MIN;
    var remaining = freeBytes - RECORD_SPACE_PADDING;
    var targetFileSize = self.get('targetFileSize');
    var maxFileSizeBytes = Math.min(remaining, targetFileSize);

    // Don't continue if there
    // is not enough space
    if (notEnoughSpace) {
      self.onRecordingError('nospace2');
      return;
    }

    // TODO: Callee should
    // pass in orientation
    var config = {
      rotation: orientation.get(),
      maxFileSizeBytes: maxFileSizeBytes
    };

    self.tmpVideo.filename = self.createTmpVideoFilename();
    mozCamera.startRecording(
      config,
      storage,
      self.tmpVideo.filename,
      onSuccess,
      self.onRecordingError);
      self.emit('recordingstart');
    }

    function onSuccess() {
      self.set('recording', true);
      self.startVideoTimer();

      // User closed app while
      // recording was trying to start
      if (document.hidden) {
        self.stopRecording();
      }

      // If the duration is too short,
      // the nno track may have been recorded.
      // That creates corrupted video files.
      // Because media file needs some samples.
      //
      // To have more information on video track,
      // we wait for 500ms to have few video and
      // audio samples, see bug 899864.
      window.setTimeout(function() {

        // TODO: Disable then re-enable
        // capture button after 500ms
        // This hsould be done in controls
        // controller.

      }, MIN_RECORDING_TIME);
    }
};

proto.stopRecording = function() {
  debug('stop recording');

  var notRecording = !this.get('recording');
  var filename = this.tmpVideo.filename;
  var storage = this.tmpVideo.storage;
  var self = this;

  if (notRecording) {
    return;
  }

  this.mozCamera.stopRecording();
  this.set('recording', false);
  this.emit('recordingend');
  this.stopVideoTimer();

  // Register a listener for writing
  // completion of current video file
  storage.addEventListener('change', onStorageChange);

  function onStorageChange(e) {
    debug('video file ready', e.path);
    var filepath = self.tmpVideo.filepath = e.path;
    var matchesFile = !!~filepath.indexOf(filename);

    // Regard the modification as
    // video file writing completion
    // if e.path matches current video
    // filename. Note e.path is absolute path.
    if (e.reason === 'modified' && matchesFile) {
      storage.removeEventListener('change', onStorageChange);
      self.getTmpVideoBlob(gotVideoBlob);
    }
  }

  function gotVideoBlob(blob) {
    getVideoMetaData(blob, function(err, data) {
      if (err) {
        return;
      }

      self.emit('newvideo', {
        blob: blob,
        poster: data.poster,
        width: data.width,
        height: data.height,
        rotation: data.rotation
      });
    });
  }
};

// TODO: This is UI stuff, so
// shouldn't be handled in this file.
proto.onRecordingError = function(id) {
  id = id || 'error-recording';
  var title = navigator.mozL10n.get(id + '-title');
  var text = navigator.mozL10n.get(id + '-text');
  alert(title + '. ' + text);
};

proto.onShutter = function() {
  this.emit('shutter');
};

proto.onRecordingStateChange = function(msg) {
  if (msg === 'FileSizeLimitReached') {
    this.emit('filesizelimitreached');
  }
};

proto.getTmpStorageSpace = function(done) {
  debug('get temp storage space');

  var storage = this.tmpVideo.storage;
  var req = storage.freeSpace();
  req.onerror = onError;
  req.onsuccess = onSuccess;

  function onSuccess() {
    var freeBytes = req.result;
    debug('%d free space found', freeBytes);
    done(null, freeBytes);
  }

  function onError() {
    done('error');
  }
};

proto.getTmpVideoBlob = function(done) {
  debug('get tmp video blob');

  var filepath = this.tmpVideo.filepath;
  var storage = this.tmpVideo.storage;
  var req = storage.get(filepath);
  req.onsuccess = onSuccess;
  req.onerror = onError;

  function onSuccess() {
    debug('got video blob');
    done(req.result);
  }

  function onError() {
    debug('failed to get \'%s\' from storage', filepath);
  }
};

proto.createTmpVideoFilename = function() {
  return Date.now() + '_tmp.3gp';
};

proto.deleteTmpVideoFile = function() {
  var storage = this.tmpVideo.storage;
  storage.delete(this.tmpVideo.filepath);
  this.tmpVideo.filename = null;
  this.tmpVideo.filepath = null;
};

proto.resumePreview = function() {
  this.mozCamera.resumePreview();
  this.emit('previewresumed');
};

proto.hasFrontCamera = function() {
  return this.get('numCameras') > 1;
};

/**
 * Toggles the camera number
 * between back (0) and front(1).
 *
 * @return {Number}
 */
proto.toggleCamera = function() {
  var newNumber = 1 - this.get('number');
  this.set('number', newNumber);
  debug('toggled: %d', newNumber);
  return this;
};

/**
 * Toggles between 'camera'
 * and 'video' capture modes.
 *
 * @return {String}
 */
proto.toggleMode = function() {
  var isCameraMode = this.get('mode') === 'camera';
  var newMode = isCameraMode ? 'video' : 'camera';
  var previewSizes;

  // NOTE:WP:
  // This looks hacky to me,
  // perhaps we can move this logic inside
  // the configurePreviewSize method.
  if (newMode === 'camera') {
    previewSizes = this.mozCamera.capabilities.previewSizes;
  } else {
    previewSizes = [{
      width: this.videoProfile.width,
      height: this.videoProfile.height
    }];
  }
  this.configurePreviewSize(previewSizes);

  this.set('mode', newMode);
  this.configureFlash(this.flash.all);
  return newMode;
};

/**
 * Cycles through flash
 * modes available for the
 * current camera (0/1) and
 * capture mode ('camera'/'video')
 * combination.
 *
 * @return {String}
 */
proto.toggleFlash = function() {
  var available = this.flash.available;
  var current = this.flash.current;
  var l = available.length;
  var next = (current + 1) % l;
  var name = available[next];

  this.setFlashMode(next);
  return name;
};

/**
 * Sets a start time and begins
 * updating the elapsed time
 * every second.
 *
 */
proto.startVideoTimer = function() {
  this.set('videoStart', new Date().getTime());
  this.videoTimer = setInterval(this.updateVideoElapsed, 1000);
  this.updateVideoElapsed();
};

proto.stopVideoTimer = function() {
  clearInterval(this.videoTimer);
  this.videoTimer = null;
};

/**
 * Calculates the elapse time
 * and updateds the 'videoElapsed'
 * value.
 *
 * We listen for the 'change:'
 * event emitted elsewhere to
 * update the UI accordingly.
 *
 */
proto.updateVideoElapsed = function() {
  var now = new Date().getTime();
  var start = this.get('videoStart');
  this.set('videoElapsed', (now - start));
};

});
