Page({
  data: {
    pingResult: null,
    pingError: null,
  },

  testCloudbaseConnection() {
    wx.showLoading({
      title: "连接中",
      mask: true,
    });
    wx.cloud
      .callFunction({
        name: "ping",
      })
      .then((response) => {
        const { ok, message, envId } = response.result || {};
        this.setData({
          pingResult: { ok, message, envId },
          pingError: null,
        });
        wx.hideLoading();
      })
      .catch((error) => {
        this.setData({
          pingResult: null,
          pingError: {
            errCode: error.errCode,
            errMsg: error.errMsg,
          },
        });
        wx.hideLoading();
      });
  }
});
