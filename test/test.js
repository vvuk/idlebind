var a = new ClassA();
ClassA.StaticMethod();
var b = a.MakeAB();
b.Foo(42);

var cc = a.GetC();
cc.v = 0;
console.log(a.GetC().v);
cc.v = 123;
a.SetC(cc);
console.log(a.GetC().v);

var q = new ClassBSubJS();
q.Foo(24);
q.Bar("Hello");


var sh = new SharedClass();
console.log(sh);
sh.destroy();

sh = new SharedClass();
a.DoShared(sh);
sh.destroy();

sh = a.MakeShared();
sh.Thing();
sh.destroy();

for (var i = 0; i < 5; ++i) {
    var num = a.AddOne(function(v) { return v *v; }, 2);
    console.log("num: ", num);
}

a.destroy();
q.destroy();

a = new ClassA(function(v) { return v * 5; });
console.log(a.foo);
a.destroy();
