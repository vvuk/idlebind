var a = new ClassA();
ClassA.StaticMethod();
var b = a.MakeAB();
b.Foo(42);

var cc = a.GetC();
cc.v = 0;
console.log(a.GetC().v);
a.SetC(cc);
console.log(a.GetC().v);

var q = new ClassBSubJS();
q.Foo(24);
q.Bar("Hello");

a.destroy();
q.destroy();

