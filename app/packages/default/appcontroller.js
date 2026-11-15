class AppController {
  constructor(options) {
    //私有回调的id
    this.__uid = cef.message.createGuid();
    this.__uid_error = this.__uid + '@error';
    this.__uid_init = this.__uid + '@init';
    this.__uid_destroy = this.__uid + '@destroy';
    this.__uid_close = this.__uid + '@close';
    this.__uid_maximize = this.__uid + '@maximize';
    this.__uid_minimize = this.__uid + '@minimize';
    this.__uid_restore = this.__uid + '@restore';
    this.__uid_fullscreen = this.__uid + '@fullscreen';
    this.__uid_reduction = this.__uid + '@reduction';	
    this.__uid_move = this.__uid + '@move';
    this.__uid_hide = this.__uid + '@hide';
	this.__uid_show = this.__uid + '@show';
	this.__uid_startapp = this.__uid + '@startapp';
	this.__uid_setwinpos = this.__uid + '@setwinpos';
	this.__uid_getwinpos = this.__uid + '@getwinpos';
	
    //传入参数
    this.topDomId = options.topDomId || ''
    this.init_callback = options.init_callback || this.__onInit
    this.error_callback = options.error_callback || this.__onError
    this.destroy_callback = options.destroy_callback || this.__onDestroy
    this.move_callback = options.move_callback || this.__onMoveWindow
  }
  //可继承的init函数
  __init_events() {
    var that = this
    that.mouseDown = false
    that.startPoint = { x: 0, y: 0 }
    that.startScreenPoint = { x: 0, y: 0 }
    that.endPoint = { x: 0, y: 0 }

    //鼠标按下事件，记录当前坐标点
    if (that.canvas) {
      that.canvas.onmousedown = function(e) {
		  that.mouseDown = true;
		  that.startPoint = { x: e.clientX, y: e.clientY };
      }
    }

    //鼠标移动事件
    window.onmousemove = function(e) {
      if (!that.mouseDown) {
        return;
      }
      that.endPoint = { x: e.clientX, y: e.clientY };
      if (that.move_callback) {
        that.move_callback(that, that.startPoint, that.endPoint);
      }
    }
    //鼠标弹起事件
    window.onmouseup = function(e) {
      if (!that.mouseDown) {
        return;
      }
      that.endPoint = { x: e.clientX, y: e.clientY };
      if (that.move_callback) {
        that.move_callback(that, that.startPoint, that.endPoint);
      }
      that.mouseDown = false;
    }
  }

  //初始化, init_callback优先于options中的回调设置
  init(win_handle_info, init_callback) {
    var that = this

    //获取Top区域dom对象
    this.canvas = document.getElementById(this.topDomId)

    //初始话事件注册
    this.__init_events()

    //注册init回调
    var cb_init = init_callback || that.init_callback || null
    cef.message.setMessageCallback(that.__uid_init, function(data) {
      if (cb_init) {
        cb_init.apply(that, [data])
      }
    })
    //注册error回调
    cef.message.setMessageCallback(that.__uid_error, function(data) {
      if (that.error_callback) {
        that.error_callback.apply(that, [data])
      }
    })
		
	//调用初始化
	win_handle_info.id = that.__uid;
	win_handle_info.error_callback_id = that.__uid_error;
	cef.message.sendMessage(that.__uid_init, 'appcontroller', 'init', JSON.stringify(win_handle_info))
  }

  // close window
  OnClose(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_close, function(data) {
      cef.message.removeMessageCallback(that.__uid_close)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_close, 'appcontroller', 'close', JSON.stringify(win_handle_info))
  }

  // maximize window
  OnMaximize(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_maximize, function(data) {
      cef.message.removeMessageCallback(that.__uid_maximize)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_maximize, 'appcontroller', 'maximize', JSON.stringify(win_handle_info))
  }

  // minimize window
  OnMinimize(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_minimize, function(data) {
      cef.message.removeMessageCallback(that.__uid_minimize)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_minimize, 'appcontroller', 'minimize', JSON.stringify(win_handle_info))
  }

  // restore window
  OnRestore(win_handle_info, callback) {
    var that = this;
    cef.message.setMessageCallback(that.__uid_restore, function (data) {
      cef.message.removeMessageCallback(that.__uid_restore);
      if (callback) {
        callback.apply(that, [data]);
      }
    });
    cef.message.sendMessage(that.__uid_restore, 'appcontroller', 'restore', JSON.stringify(win_handle_info))
  }

  // move window
  OnMoveWindow(start, end, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_move, function(data) {
      cef.message.removeMessageCallback(that.__uid_move)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    var data = { "startPoint": start, "endPoint": end }
    cef.message.sendMessage(that.__uid_move, 'appcontroller', 'move', JSON.stringify(data));
  }

  // fullscreen windows
  OnFullScreen(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_fullscreen, function(data) {
      cef.message.removeMessageCallback(that.__uid_fullscreen)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_fullscreen, 'appcontroller', 'fullscreen', JSON.stringify(win_handle_info))
  }

  // fullscreen windows
  OnReduction(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_reduction, function(data) {
      cef.message.removeMessageCallback(that.__uid_reduction)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_reduction, 'appcontroller', 'reduction', JSON.stringify(win_handle_info))
  }
  // Hide window
  OnHide(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_hide, function(data) {
      cef.message.removeMessageCallback(that.__uid_hide)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_hide, 'appcontroller', 'hide', JSON.stringify(win_handle_info))
  }
   // Show window
  OnShow(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_show, function(data) {
      cef.message.removeMessageCallback(that.__uid_show)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_show, 'appcontroller', 'show', JSON.stringify(win_handle_info))
  }
  
  // get windows position
  // add by hqli3 20231108
  // 返回参数 win_x:int, win_y:int, win_width:int, win_height:int
  OnGetWinPos(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_getwinpos, function(data) {
      cef.message.removeMessageCallback(that.__uid_getwinpos)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_getwinpos, 'appcontroller', 'get_win_pos', JSON.stringify(win_handle_info))
  }
  
  // set windows position
  // add by hqli3 20231108
  // 输入参数 win_x:int, win_y:int, win_width:int, win_height:int
  // 当win_x与win_y设为-1, 则看作居中 
  OnSetWinPos(win_handle_info, callback) {
    var that = this
    cef.message.setMessageCallback(that.__uid_setwinpos, function(data) {
      cef.message.removeMessageCallback(that.__uid_setwinpos)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(that.__uid_setwinpos, 'appcontroller', 'set_win_pos', JSON.stringify(win_handle_info))
  }
  
  OnStartApp(params, callback_run, callback_exit) {
    var that = this
	var _apprun_callback_id = cef.message.createGuid() + '@apprun';
	var _appexit_callback_id = cef.message.createGuid() + '@appexit';
    cef.message.setMessageCallback(that.__uid_show, function(data) {
      cef.message.removeMessageCallback(that.__uid_show)
      //if (callback) {
      //  callback.apply(that, [data])
      //}
    })
    cef.message.setMessageCallback(_apprun_callback_id, function(data) {
      cef.message.removeMessageCallback(_apprun_callback_id)
      if (callback_run) {
        callback_run.apply(that, [data])
      }
    })
    cef.message.setMessageCallback(_appexit_callback_id, function(data) {
      cef.message.removeMessageCallback(_appexit_callback_id)
      if (callback_exit) {
        callback_exit.apply(that, [data])
      }
    })	
	params.apprun_callback_id = _apprun_callback_id;
	params.appexit_callback_id = _appexit_callback_id;
    cef.message.sendMessage(that.__uid_show, 'appcontroller', 'startapp', JSON.stringify(params))
  }
  OnIdgExist(params, callback) {
    var that = this
	var _idg_exist = cef.message.createGuid() + '@_idg_exist';
    cef.message.setMessageCallback(_idg_exist, function(data) {
      cef.message.removeMessageCallback(_idg_exist)
      if (callback) {
        callback.apply(that, [data])
      }
    })
    cef.message.sendMessage(_idg_exist, 'appcontroller', 'idg_exist', JSON.stringify(params))
  }
  // destroy callback
  __onDestroy(data) {
    console.log('appcontroller/onDestroy, result:%s', data)
  }

  // init callback
  __onInit(data) {
    console.log('appcontroller/onInit, result:%s', data)
  }

  // error callback
  __onError(data) {
    console.error('appcontroller/onError,error:%s', data)
    //alert('SysConfig error:' + data);
  }
  // error callback
  __onMoveWindow(data) {
    console.error('appcontroller/onMoveWindow,error:%s', data)
  }
}
