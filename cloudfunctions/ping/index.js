// 最简联通测试云函数 —— 不访问数据库、不访问存储、不调用 wx-server-sdk
exports.main = async (event, context) => {
  return {
    ok: true,
    message: "cloudbase connected",
    envId: "aa-d4gvb4o3t50fc94f8",
  };
};
